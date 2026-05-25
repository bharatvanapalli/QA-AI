import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Brain, Trash2, Plus, Search, AlertTriangle, TrendingDown, TrendingUp,
  ChevronDown, ChevronRight, Wand2, Loader2, Sparkles, History as HistoryIcon, X,
} from 'lucide-react';
import api, { ApiError } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useConfirm } from '../lib/useConfirm';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';

/**
 * Knowledge Base page (Phase E1.5 — closes original Phase 9).
 *
 * Shows every learned locator with:
 *   - Search by element / selector / accessibleName / role
 *   - Top 10 flaky locators (most failureCount) in a side panel
 *   - Per-locator expandable detail: healHistory timeline (SVG sparkline),
 *     intent / accessibleName / role / pageUrl, full healHistory list
 *   - Heal-now CTA (mirrors the BlockedItems flow — POST to
 *     /knowledge-base/:id/heal-now, surfaces proposal inline)
 *   - Quarantine badge for entries with healthScore < 30
 *
 * Data shape comes from the E1.1 schema (KnowledgeBaseLocator with intent /
 * accessibleName / role / pageUrl / domAnchor / failureCount / lastFailedAt /
 * healHistory). Quarantine threshold is hard-coded to 30 to match
 * server/services/agents/conductor.js QUARANTINE_HEALTH.
 */

const QUARANTINE_HEALTH = 30;

export default function KnowledgeBase() {
  const { current } = useProject();
  const toast = useToast();
  const confirm = useConfirm();
  const [locators, setLocators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ element: '', selector: '', strategy: 'role' });
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(null); // locator id whose row is expanded

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

  useEffect(() => { load(); }, [load]);

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
      destructive: true,
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
  const quarantined = locators.filter((l) => l.healthScore < QUARANTINE_HEALTH).length;
  const needAttention = locators.filter((l) => l.healthScore >= QUARANTINE_HEALTH && l.healthScore < 50).length;

  // Filter by search query — matches element, selector, accessibleName, role, intent.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return locators;
    return locators.filter((l) => {
      const hay = [l.element, l.selector, l.accessibleName, l.role, l.intent, l.pageUrl]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [locators, query]);

  // Top-10 flakiest = highest failureCount, tie-break on lowest healthScore.
  const topFlaky = useMemo(() => {
    return locators
      .slice()
      .filter((l) => (l.failureCount || 0) > 0)
      .sort((a, b) => (b.failureCount || 0) - (a.failureCount || 0) || (a.healthScore || 0) - (b.healthScore || 0))
      .slice(0, 10);
  }, [locators]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Knowledge Base"
        subtitle={total
          ? `${total} locator${total === 1 ? '' : 's'} · ${healthy} healthy · ${needAttention} watching · ${quarantined} quarantined`
          : 'Locators auto-populate as the agent learns the site.'}
      >
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="w-3.5 h-3.5" />
          Add locator
        </Button>
      </PageHeader>

      <main className="flex-1 overflow-y-auto bg-ink-50">
        <div className="max-w-6xl mx-auto px-page py-6 space-y-5">
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
              message="Locators are auto-populated when the agent successfully interacts with elements during a run. Start a run from the Live Pipeline to seed the KB."
            />
          ) : (
            <div className="grid lg:grid-cols-[1fr_320px] gap-5">
              {/* Main list */}
              <section className="space-y-3 min-w-0">
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by element, selector, role, or accessible name…"
                    className="w-full h-10 pl-10 pr-10 rounded-md border border-ink-200 bg-white text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none focus:border-ink-900 focus:shadow-ring transition-all"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700"
                      aria-label="Clear search"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                {query && (
                  <div className="text-2xs text-ink-500">
                    {filtered.length} of {total} match{filtered.length === 1 ? 'es' : 'es'} "{query}"
                  </div>
                )}
                {filtered.length === 0 ? (
                  <div className="rounded-card border border-ink-200 bg-white p-8 text-center text-sm text-ink-500">
                    No locators match the current search.
                  </div>
                ) : (
                  <div className="rounded-card border border-ink-200 bg-white shadow-card overflow-hidden">
                    <ul className="divide-y divide-ink-100">
                      {filtered.map((l) => (
                        <LocatorRow
                          key={l.id}
                          locator={l}
                          expanded={expanded === l.id}
                          onToggle={() => setExpanded((cur) => (cur === l.id ? null : l.id))}
                          onRemove={() => remove(l)}
                          projectId={current.id}
                          onChanged={load}
                        />
                      ))}
                    </ul>
                  </div>
                )}
              </section>

              {/* Top-flaky side panel */}
              <aside className="space-y-3">
                <div className="rounded-card border border-ink-200 bg-white shadow-card p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle className="w-4 h-4 text-warn-700" />
                    <h2 className="text-sm font-semibold text-ink-900 tracking-tight">Top flaky locators</h2>
                  </div>
                  {topFlaky.length === 0 ? (
                    <div className="text-xs text-ink-500 italic">
                      No failures yet — every locator has held up so far.
                    </div>
                  ) : (
                    <ol className="space-y-2.5">
                      {topFlaky.map((l, i) => {
                        const tone = l.healthScore < QUARANTINE_HEALTH
                          ? 'text-danger-700'
                          : l.healthScore < 50 ? 'text-warn-700' : 'text-ink-700';
                        return (
                          <li key={l.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setExpanded(l.id);
                                // Scroll the row into view if it's in the filtered list.
                                requestAnimationFrame(() => {
                                  document.getElementById(`kb-row-${l.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                });
                              }}
                              className="w-full text-left flex items-start gap-2 group"
                            >
                              <span className="text-2xs font-bold text-ink-400 w-4 shrink-0 tabular-nums">{i + 1}.</span>
                              <span className="flex-1 min-w-0">
                                <span className="text-xs font-semibold text-ink-800 truncate block group-hover:text-ink-900" title={l.element}>
                                  {l.element}
                                </span>
                                <span className={`text-2xs tabular-nums ${tone}`}>
                                  {l.failureCount} fail{l.failureCount === 1 ? '' : 's'} · health {l.healthScore}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>

                <div className="rounded-card border border-info-100 bg-info-50/40 p-4 text-2xs text-info-900 leading-relaxed">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Sparkles className="w-3.5 h-3.5" />
                    <span className="font-bold uppercase tracking-wider">How this works</span>
                  </div>
                  Locators auto-capture when the agent successfully touches an element (first-sighting). On failure, the AI healer reads the live DOM, finds the renamed element, retries, and updates this row. Health drops on failure, recovers on heal. Below 30 = quarantined; the agent refuses to retry it.
                </div>
              </aside>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ── LocatorRow ──────────────────────────────────────────────
// Renders one KB locator. Default-collapsed; expanding reveals the health
// timeline + heal history + heal-now CTA + intent metadata.
function LocatorRow({ locator: l, expanded, onToggle, onRemove, projectId, onChanged }) {
  const toast = useToast();
  const [healing, setHealing] = useState(false);
  const [healResult, setHealResult] = useState(null);

  const isQuarantined = (l.healthScore ?? 100) < QUARANTINE_HEALTH;
  const isHealthy = (l.healthScore ?? 0) >= 80;
  const bar = isQuarantined ? 'bg-danger-500' : isHealthy ? 'bg-success-500' : (l.healthScore ?? 0) >= 50 ? 'bg-warn-500' : 'bg-danger-500';

  // Parse the JSON-encoded healHistory once per render.
  const history = useMemo(() => {
    if (!l.healHistory) return [];
    try {
      const arr = JSON.parse(l.healHistory);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }, [l.healHistory]);

  // Reconstruct healthScore trajectory from healHistory. The current
  // healthScore is the endpoint; we walk BACKWARDS through history applying
  // the inverse of each delta (failure = -20, success heal = +5). It's an
  // approximation — first-sighting deltas aren't tracked in healHistory —
  // but it's enough for a visual trend.
  const trajectory = useMemo(() => {
    if (!history.length) return [];
    const points = [l.healthScore ?? 100];
    let cur = l.healthScore ?? 100;
    for (let i = history.length - 1; i >= 0; i--) {
      const ent = history[i];
      if (ent.outcome === 'success') cur = Math.max(0, cur - 5);
      else if (ent.outcome === 'failed' || ent.outcome === 'low_confidence') cur = Math.min(100, cur + 20);
      points.unshift(cur);
    }
    return points;
  }, [history, l.healthScore]);

  const healFromCurrentDom = async () => {
    setHealing(true);
    setHealResult(null);
    try {
      const res = await api.post(`/projects/${projectId}/knowledge-base/${l.id}/heal-now`, {});
      setHealResult(res);
      if (res.healed && res.healed.confidence >= 70) {
        toast.success(`Healed (${res.healed.confidence}% confidence). KB updated.`, { title: 'Heal succeeded' });
      } else if (res.healed) {
        toast.info(`Healer confidence ${res.healed.confidence}% — KB stayed unchanged.`, { title: 'Low confidence' });
      } else {
        toast.info('Healer found no replacement in the current DOM.', { title: 'No proposal' });
      }
      onChanged?.();
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Heal failed' });
    } finally {
      setHealing(false);
    }
  };

  return (
    <li id={`kb-row-${l.id}`} className={isQuarantined ? 'bg-danger-50/30' : ''}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-5 py-3.5 hover:bg-ink-50 transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-3 flex-wrap">
          {expanded ? <ChevronDown className="w-4 h-4 text-ink-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-ink-500 shrink-0" />}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-ink-900 truncate" title={l.element}>{l.element}</span>
              {l.strategy && (
                <span className="px-1.5 py-0.5 rounded bg-ink-100 font-mono text-2xs uppercase tracking-wider text-ink-700">
                  {l.strategy}
                </span>
              )}
              {isQuarantined && (
                <span className="px-1.5 py-0.5 rounded-pill bg-danger-100 text-danger-700 text-2xs font-bold uppercase tracking-wider">
                  Quarantined
                </span>
              )}
              {(l.failureCount || 0) > 0 && (
                <span className="px-1.5 py-0.5 rounded-pill bg-warn-50 text-warn-700 text-2xs font-bold tabular-nums">
                  {l.failureCount} fail{l.failureCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div className="text-2xs text-ink-500 font-mono truncate mt-0.5">{l.selector}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-28 h-2 bg-ink-100 rounded-pill overflow-hidden">
              <div className={`h-full rounded-pill ${bar}`} style={{ width: `${Math.max(0, Math.min(100, l.healthScore ?? 100))}%` }} />
            </div>
            <span className="text-xs font-semibold w-9 text-right tabular-nums">
              {l.healthScore ?? '—'}
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-5 pt-1 border-t border-ink-100 bg-ink-50/40 space-y-4">
          {/* Intent metadata */}
          <div className="grid sm:grid-cols-2 gap-3 text-xs">
            <MetaField label="Intent" value={l.intent} />
            <MetaField label="Accessible name" value={l.accessibleName} />
            <MetaField label="ARIA role" value={l.role} />
            <MetaField label="Page URL" value={l.pageUrl} mono />
            <MetaField label="Occurrences" value={l.occurrences != null ? String(l.occurrences) : null} />
            <MetaField
              label="Last healed"
              value={l.lastHealedAt ? new Date(l.lastHealedAt).toLocaleString() : null}
            />
          </div>

          {/* Health timeline */}
          <div className="rounded-md border border-ink-200 bg-white p-3">
            <div className="flex items-center gap-2 mb-2">
              <HistoryIcon className="w-3.5 h-3.5 text-ink-500" />
              <span className="text-2xs font-bold uppercase tracking-wider text-ink-600">Health timeline</span>
              {trajectory.length >= 2 && (
                <span className="ml-auto inline-flex items-center gap-1 text-2xs font-semibold">
                  {trajectory[trajectory.length - 1] >= trajectory[0]
                    ? <><TrendingUp className="w-3 h-3 text-success-700" /><span className="text-success-700">recovering</span></>
                    : <><TrendingDown className="w-3 h-3 text-danger-700" /><span className="text-danger-700">declining</span></>}
                </span>
              )}
            </div>
            {trajectory.length >= 2 ? (
              <HealthLine values={trajectory} />
            ) : (
              <div className="text-2xs text-ink-500 italic">Not enough heal events yet — timeline appears after the first failure or heal attempt.</div>
            )}
          </div>

          {/* Heal-now CTA */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={healFromCurrentDom}
              disabled={healing}
              loading={healing}
              title="Open a fresh browser to this page and ask the AI to find the element in the live DOM"
            >
              {healing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
              Heal from current DOM
            </Button>
            <Button size="sm" variant="ghost" onClick={onRemove} className="text-danger-600">
              <Trash2 className="w-3 h-3" />
              Remove
            </Button>
          </div>

          {healResult && (
            <div className="rounded-md border border-ink-200 bg-white p-3 text-xs space-y-1">
              {healResult.healed ? (
                <>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-2xs uppercase tracking-wider font-bold text-accent-700">Healer proposal</span>
                    <span className="font-mono text-2xs text-ink-600">{healResult.healed.strategy}</span>
                    <span className={`text-2xs font-bold tabular-nums ${healResult.healed.confidence >= 70 ? 'text-success-700' : 'text-warn-700'}`}>
                      {healResult.healed.confidence}% confidence
                    </span>
                  </div>
                  <div className="font-mono text-2xs text-ink-800 bg-ink-50 rounded p-2 break-all">
                    {healResult.healed.selector}
                  </div>
                  {healResult.healed.reasoning && (
                    <div className="text-2xs text-ink-600 italic">{healResult.healed.reasoning}</div>
                  )}
                </>
              ) : (
                <div className="text-2xs text-ink-600 italic">Healer found no matching element in the current DOM snapshot.</div>
              )}
            </div>
          )}

          {/* Heal history list */}
          {history.length > 0 && (
            <div>
              <div className="text-2xs font-bold uppercase tracking-wider text-ink-600 mb-2">
                Heal history · {history.length} event{history.length === 1 ? '' : 's'}
              </div>
              <ul className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {history.slice().reverse().map((h, i) => (
                  <li key={i} className="border-l-2 pl-3 py-1 text-2xs"
                      style={{ borderColor: h.outcome === 'success' ? '#22c55e' : h.outcome === 'low_confidence' ? '#f59e0b' : '#ef4444' }}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold uppercase tracking-wider">
                        {h.outcome === 'success' ? 'Heal succeeded'
                          : h.outcome === 'low_confidence' ? 'Low confidence'
                          : 'Heal failed'}
                      </span>
                      {h.source && (
                        <span className="px-1.5 py-0.5 rounded bg-ink-100 text-ink-600 font-mono uppercase">{h.source}</span>
                      )}
                      {typeof h.confidence === 'number' && (
                        <span className="text-ink-500 tabular-nums">conf {h.confidence}%</span>
                      )}
                      {h.ts && (
                        <span className="ml-auto text-ink-400 tabular-nums">{new Date(h.ts).toLocaleString()}</span>
                      )}
                    </div>
                    {h.newSelector && (
                      <div className="font-mono text-ink-700 mt-0.5 break-all">→ {h.newSelector}</div>
                    )}
                    {h.reason && <div className="text-ink-500 italic mt-0.5">{h.reason}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function MetaField({ label, value, mono }) {
  return (
    <div>
      <div className="text-2xs font-bold uppercase tracking-wider text-ink-500 mb-0.5">{label}</div>
      {value
        ? <div className={`text-ink-800 ${mono ? 'font-mono text-2xs break-all' : ''}`}>{value}</div>
        : <div className="text-ink-400 italic">—</div>}
    </div>
  );
}

// Bigger health-trajectory line than the dashboard Sparkline — fills the
// container width, shows a baseline at 30 (quarantine threshold).
function HealthLine({ values }) {
  const width = 480;
  const height = 64;
  const padding = 6;
  const max = 100;
  const min = 0;
  const range = max - min;
  const points = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * (width - padding * 2) + padding;
    const y = height - padding - ((v - min) / range) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const quarantineY = height - padding - ((QUARANTINE_HEALTH - min) / range) * (height - padding * 2);
  const last = values[values.length - 1];
  const stroke = last >= 80 ? '#22c55e' : last >= 50 ? '#f59e0b' : '#ef4444';

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block">
      {/* Quarantine threshold line */}
      <line
        x1={padding} y1={quarantineY} x2={width - padding} y2={quarantineY}
        stroke="#ef4444" strokeWidth="0.8" strokeDasharray="2,3" opacity="0.4"
      />
      <text x={width - padding - 2} y={quarantineY - 2} textAnchor="end" fontSize="8" fill="#ef4444" opacity="0.7">
        quarantine
      </text>
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Last-point dot */}
      {points.length > 0 && (() => {
        const [x, y] = points[points.length - 1].split(',');
        return <circle cx={x} cy={y} r="2.5" fill={stroke} />;
      })()}
    </svg>
  );
}
