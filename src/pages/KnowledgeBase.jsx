import React, { useEffect, useState, useCallback } from 'react';
import { Brain, Trash2, Plus } from 'lucide-react';
import api from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useConfirm } from '../lib/useConfirm';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';

export default function KnowledgeBase() {
  const { current } = useProject();
  const toast = useToast();
  const confirm = useConfirm();
  const [locators, setLocators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ element: '', selector: '', strategy: 'role' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get(`/projects/${current.id}/knowledge-base`);
      setLocators(res.locators || []);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [current, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!form.element || !form.selector) return;
    setSaving(true);
    try {
      await api.post(`/projects/${current.id}/knowledge-base`, form);
      setForm({ element: '', selector: '', strategy: 'role' });
      setAdding(false);
      await load();
      toast.success('Locator added.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (loc) => {
    const ok = await confirm({
      title: `Remove "${loc.element}"?`,
      message: 'This locator will be removed from the knowledge base. Tests that depend on it may fail until a replacement is provided.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await api.del(`/projects/${current.id}/knowledge-base/${loc.id}`);
      await load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Knowledge Base" />
        <EmptyState icon={Brain} title="No project selected" message="Activate a project to see locators." />
      </div>
    );
  }

  const total = locators.length;
  const healthy = locators.filter((l) => l.healthScore >= 80).length;
  const failing = locators.filter((l) => l.healthScore < 50).length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Knowledge Base"
        subtitle={`${total} locator${total === 1 ? '' : 's'} · ${healthy} healthy · ${failing} need attention`}
      >
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="w-3.5 h-3.5" />
          Add locator
        </Button>
      </PageHeader>

      <main className="flex-1 overflow-y-auto bg-ink-50">
        <div className="max-w-5xl mx-auto px-page py-8 space-y-5">
          {adding && (
            <div className="rounded-lg border border-ink-200 bg-white p-4 space-y-3">
              <h2 className="font-semibold text-ink-900 text-sm">New locator</h2>
              <Input
                label="Element"
                value={form.element}
                onChange={(e) => setForm({ ...form, element: e.target.value })}
                placeholder="Submit button"
              />
              <Input
                label="Selector"
                value={form.selector}
                onChange={(e) => setForm({ ...form, selector: e.target.value })}
                placeholder='[data-testid="submit"]'
              />
              <Select
                label="Strategy"
                value={form.strategy}
                onChange={(e) => setForm({ ...form, strategy: e.target.value })}
                options={['role', 'testid', 'css', 'xpath']}
              />
              <div className="flex justify-end gap-2 pt-2 border-t border-ink-100">
                <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={save} loading={saving} disabled={saving}>
                  Save
                </Button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="text-xs text-ink-500">Loading…</div>
          ) : total === 0 ? (
            <EmptyState
              icon={Brain}
              title="Empty knowledge base"
              message="Locators are auto-populated when you resolve blocked items with a replacement selector. You can also add them manually."
            />
          ) : (
            <div className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-ink-50 text-2xs font-bold text-ink-600 uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-5 py-3">Element</th>
                    <th className="text-left px-5 py-3">Selector</th>
                    <th className="text-left px-5 py-3">Strategy</th>
                    <th className="text-right px-5 py-3">Used</th>
                    <th className="text-right px-5 py-3 w-44">Health</th>
                    <th className="w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {locators.map((l) => (
                    <tr key={l.id} className="border-t border-ink-100 hover:bg-ink-50/60 transition-colors">
                      <td className="px-5 py-3.5 font-semibold text-ink-900">{l.element}</td>
                      <td className="px-5 py-3.5 font-mono text-xs text-ink-700 truncate max-w-[320px]">
                        {l.selector}
                      </td>
                      <td className="px-5 py-3.5 text-xs">
                        <span className="px-2 py-0.5 rounded bg-ink-100 font-mono text-2xs uppercase tracking-wider text-ink-700">
                          {l.strategy || '—'}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right text-xs tabular-nums">{l.occurrences}</td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="flex-1 h-2 bg-ink-100 rounded-pill overflow-hidden">
                            <div
                              className={`h-full rounded-pill ${
                                l.healthScore >= 80
                                  ? 'bg-success-500'
                                  : l.healthScore >= 50
                                  ? 'bg-warn-500'
                                  : 'bg-danger-500'
                              }`}
                              style={{ width: `${l.healthScore}%` }}
                            />
                          </div>
                          <span className="text-xs font-semibold w-9 text-right tabular-nums">
                            {l.healthScore}%
                          </span>
                        </div>
                      </td>
                      <td className="px-3 text-right">
                        <button
                          onClick={() => remove(l)}
                          className="text-ink-400 hover:text-danger-600 hover:bg-danger-50 rounded p-1.5 transition-colors"
                          aria-label="Remove"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
