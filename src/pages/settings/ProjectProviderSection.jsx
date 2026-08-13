import React, { useEffect, useState, useCallback } from 'react';
import { Save, Cpu, Loader2 } from 'lucide-react';
import api, { ApiError } from '../../lib/apiClient';
import { useToast } from '../../lib/useToast';
import { useProject } from '../../store/project';
import Button from '../../components/ui/Button';
import Select from '../../components/ui/Select';

/**
 * Per-project AI provider selector.
 *
 * Decides which LLM provider this project's agents (Architect, Planner,
 * Conductor, Critic, Supervisor, Analyst, Reporter, RCA Chat) call into.
 * Persisted on `Project.aiProvider` via PUT /api/projects/:id/provider.
 *
 * Surfaced on BOTH Claude and Gemini settings pages so the user can flip
 * providers from whichever page they're already on.
 */
export default function ProjectProviderSection() {
  const { current } = useProject();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [serverValue, setServerValue] = useState('claude');
  const [value, setValue] = useState('claude');

  useEffect(() => {
    if (!current) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get(`/projects/${current.id}`);
        if (cancelled) return;
        const v = res.project?.aiProvider || 'claude';
        setServerValue(v);
        setValue(v);
      } catch (err) {
        if (!cancelled) toast.error(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const dirty = value !== serverValue;

  const handleSave = useCallback(async () => {
    if (!current) return;
    setSaving(true);
    try {
      const res = await api.put(`/projects/${current.id}/provider`, { aiProvider: value });
      const newProvider = res.project?.aiProvider || value;
      setServerValue(newProvider);
      setValue(newProvider);
      toast.success(
        `Project will now run agents on ${newProvider === 'gemini' ? 'Gemini' : 'Claude'}.`,
        { title: 'Provider updated' },
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not update provider' });
    } finally {
      setSaving(false);
    }
  }, [current, value, toast]);

  if (!current) {
    return (
      <div className="rounded-lg border border-ink-200 bg-white p-5 space-y-2">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-accent-600" aria-hidden="true" />
          <h3 className="text-md font-semibold text-ink-900">Active AI provider</h3>
        </div>
        <p className="text-xs text-ink-500">
          Activate a project to choose which AI provider its agents call into.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-ink-200 bg-white p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-accent-600" aria-hidden="true" />
          <div>
            <h3 className="text-md font-semibold text-ink-900">Active AI provider</h3>
            <p className="text-xs text-ink-500 mt-0.5">
              Which provider runs every agent for{' '}
              <span className="font-semibold text-ink-700">{current.name}</span>.
              The chosen provider must have a valid API key configured in this Settings area.
            </p>
          </div>
        </div>
      </div>
      <div className="flex items-end gap-3 flex-wrap">
        <Select
          label="Provider"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          options={[
            { value: 'claude', label: 'Claude (Anthropic)' },
            { value: 'gemini', label: 'Gemini (Google)' },
            { value: 'copilot', label: 'GitHub Copilot (VS Code Bridge)' },
          ]}
          disabled={loading || saving}
          hint={
            value === 'copilot'
              ? 'Agents route through the local VS Code GitHub Copilot Bridge (http://127.0.0.1:5005).'
              : value === 'gemini'
                ? 'Agents call Google Generative AI. Rate-limit chip is hidden — Google does not return per-request headroom.'
                : 'Agents call Anthropic. Rate-limit chip shows live tokens-remaining from the response headers.'
          }
        />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!dirty || saving || loading}
          loading={saving}
        >
          <Save className="w-3.5 h-3.5" />
          {dirty ? 'Save provider' : 'No changes'}
        </Button>
      </div>
      {loading && (
        <div className="text-2xs text-ink-500 inline-flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading project provider…
        </div>
      )}
    </div>
  );
}
