import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Brain, Trash2, Search, AlertTriangle, TrendingDown,
  ChevronDown, ChevronRight, Wand2, Loader2, Sparkles, X,
  Copy as CopyIcon, Check, Globe, Layers, FileCode,
  ShieldAlert, Activity, RefreshCw, HelpCircle, Eye,
} from 'lucide-react';
import api, { ApiError } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useConfirm } from '../lib/useConfirm';
import { useRunStream } from '../store/runStream';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';

const QUARANTINE_HEALTH = 30;
const WATCHING_HIGH = 70;

// ─────────────────────────────────────────────────────────────────────────────
// AuroraBackground — same drifting orbs used across the app. Tuned to a
// cooler palette (accent / info) because KB is the "learning" page.
// ─────────────────────────────────────────────────────────────────────────────
function AuroraBackground() {
  return (
    <div className="aurora-canvas grain-overlay" aria-hidden="true">
      <div className="aurora-orb aurora-orb-accent  aurora-drift-1"
           style={{ width: '52vw', height: '52vw', top: '-10vw', left: '-6vw', opacity: 0.45 }} />
      <div className="aurora-orb aurora-orb-info    aurora-drift-2"
           style={{ width: '46vw', height: '46vw', top: '-4vw', right: '-8vw', opacity: 0.42 }} />
      <div className="aurora-orb aurora-orb-success aurora-drift-3"
           style={{ width: '42vw', height: '42vw', bottom: '-12vw', left: '20vw', opacity: 0.36 }} />
      <div className="aurora-orb aurora-orb-warn    aurora-drift-1"
           style={{ width: '34vw', height: '34vw', bottom: '-10vw', right: '8vw', opacity: 0.28 }} />
    </div>
  );
}

// Health classification — used for chips, sort, filter, and the bar tone.
function healthClass(h) {
  const score = h ?? 100;
  if (score < QUARANTINE_HEALTH) return 'quarantined';
  if (score < WATCHING_HIGH) return 'watching';
  return 'healthy';
}

const HEALTH_META = {
  healthy:     { label: 'Healthy',     barCls: 'bg-success-500', textCls: 'text-success-700' },
  watching:    { label: 'Watching',    barCls: 'bg-warn-500',    textCls: 'text-warn-700' },
  quarantined: { label: 'Quarantined', barCls: 'bg-danger-500',  textCls: 'text-danger-700' },
};

// Strategy → friendly label + colour. Same palette as elsewhere in the app.
const STRATEGY_META = {
  role:        { label: 'role',        cls: 'bg-success-50 text-success-700 border-success-200' },
  testid:      { label: 'test id',     cls: 'bg-success-50 text-success-700 border-success-200' },
  placeholder: { label: 'placeholder', cls: 'bg-info-50 text-info-700 border-info-100' },
  text:        { label: 'text',        cls: 'bg-warn-50 text-warn-700 border-warn-200' },
  css:         { label: 'css',         cls: 'bg-ink-100 text-ink-700 border-ink-200' },
};

// Group locators by pageUrl. Returns an array of { url, locators[] }
// preserving health-priority ordering within each group. Locators with no
// pageUrl get grouped under a synthetic "(unspecified)" bucket so they're
// still visible — likely from legacy rows captured before pageUrl was
// being recorded.
function groupByPage(locators) {
  const map = new Map();
  for (const l of locators) {
    const key = l.pageUrl || '(unspecified)';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(l);
  }
  // Within each page, sort by health asc (problems first), then occurrences desc.
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      const ha = a.healthScore ?? 100;
      const hb = b.healthScore ?? 100;
      if (ha !== hb) return ha - hb;
      return (b.occurrences || 0) - (a.occurrences || 0);
    });
  }
  // Page order: groups with quarantined first, then watching, then healthy.
  return [...map.entries()]
    .map(([url, arr]) => ({ url, locators: arr }))
    .sort((a, b) => {
      const minA = Math.min(...a.locators.map((l) => l.healthScore ?? 100));
      const minB = Math.min(...b.locators.map((l) => l.healthScore ?? 100));
      if (minA !== minB) return minA - minB;
      return a.url.localeCompare(b.url);
    });
}

// Short display version of a URL — drops protocol and trailing slash so it
// fits in a folder header. Full URL stays available as the title attribute.
function shortUrl(u) {
  if (!u || u === '(unspecified)') return u;
  return String(u).replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function formatRelative(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export default function KnowledgeBase() {
  const { current } = useProject();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { subscribe } = useRunStream();

  const [locators, setLocators] = useState([]);
  const [stats, setStats] = useState({ total: 0, healthy: 0, watching: 0, quarantined: 0 });
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all'); // all | watching | quarantined
  const [expanded, setExpanded] = useState(null);
  // Set of locator ids that just got captured / updated by a live run.
  // Drives a brief highlight ring on the row so the user sees activity.
  const [recentlyTouched, setRecentlyTouched] = useState(() => new Set());
  // Banner toast when KB grows during the current page session.
  const [liveCaptureCount, setLiveCaptureCount] = useState(0);
  const liveResetTimeoutRef = useRef(null);
  // Mirror of known locator ids — lets the subscribe callback distinguish new
  // rows from updates without reading stale React state (state updaters are
  // async; reading locators directly inside the callback would be stale).
  const knownLocatorIdsRef = useRef(new Set());

  const load = useCallback(async () => {
    if (!current) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await api.get(`/projects/${current.id}/knowledge-base`);
      const loaded = res.locators || [];
      setLocators(loaded);
      knownLocatorIdsRef.current = new Set(loaded.map((l) => l.id));
      setStats(res.stats || { total: 0, healthy: 0, watching: 0, quarantined: 0 });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [current, toast]);

  useEffect(() => { load(); }, [load]);

  // Isolation — clear the previous project's locators the instant the active
  // project changes, so they can't linger on the new project's list during
  // the refetch window (the cross-project stale-paint class).
  useEffect(() => {
    setLocators([]);
    setStats({ total: 0, healthy: 0, watching: 0, quarantined: 0 });
    setLoading(true);
  }, [current?.id]);

  // Live capture from the conductor — the WS `locator.captured` event is
  // broadcast on every successful tool call that touches an element. We
  // upsert the row in place, flash it, and tick a counter so the banner
  // can render "+N captured this run".
  useEffect(() => {
    if (!current?.id) return;
    return subscribe((msg) => {
      if (msg.type !== 'locator.captured') return;
      if (msg.projectId && msg.projectId !== current.id) return;
      const incoming = msg.locator;
      if (!incoming) return;
      const isNew = !knownLocatorIdsRef.current.has(incoming.id);
      if (isNew) knownLocatorIdsRef.current.add(incoming.id);
      setLocators((prev) => {
        const idx = prev.findIndex((l) => l.id === incoming.id);
        if (idx === -1) return [{ ...incoming }, ...prev];
        const next = prev.slice();
        next[idx] = { ...next[idx], ...incoming };
        return next;
      });
      // Only increment total for new locators — upserts must not inflate the
      // counter. Exact counts come from the refetch on run.complete.
      if (isNew) {
        setStats((prev) => ({ ...prev, total: prev.total + 1 }));
      }
      setRecentlyTouched((prev) => {
        const next = new Set(prev);
        next.add(incoming.id);
        return next;
      });
      setLiveCaptureCount((n) => n + 1);
      if (liveResetTimeoutRef.current) clearTimeout(liveResetTimeoutRef.current);
      // After ~12s of no events, fade the ring + reset the counter so it
      // doesn't persist forever.
      liveResetTimeoutRef.current = setTimeout(() => {
        setRecentlyTouched(new Set());
      }, 12_000);
    });
  }, [subscribe, current?.id]);

  // Settle on run.complete: refetch so server-side counts + usedBy
  // footprints are accurate. The optimistic mid-run state is approximate.
  useEffect(() => {
    if (!current?.id) return;
    return subscribe((msg) => {
      if (msg.type === 'run.complete') load();
    });
  }, [subscribe, current?.id, load]);

  const filteredLocators = useMemo(() => {
    const q = query.trim().toLowerCase();
    return locators.filter((l) => {
      // Filter chips
      const cls = healthClass(l.healthScore);
      if (filter === 'watching' && cls !== 'watching') return false;
      if (filter === 'quarantined' && cls !== 'quarantined') return false;
      // Search
      if (!q) return true;
      const hay = [
        l.element, l.intent, l.selector, l.accessibleName,
        l.role, l.pageUrl, l.strategy,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [locators, query, filter]);

  const groups = useMemo(() => groupByPage(filteredLocators), [filteredLocators]);

  const remove = async (locator) => {
    const ok = await confirm({
      title: 'Remove this locator?',
      message: `"${locator.element}" will be deleted from the Knowledge Base. The next successful run that touches this element will recapture it from the live page. Heal history is lost.`,
      confirmLabel: 'Remove locator',
      cancelLabel: 'Keep',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/projects/${current.id}/knowledge-base/${locator.id}`);
      setLocators((all) => all.filter((x) => x.id !== locator.id));
      toast.success(`Removed "${locator.element}".`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Could not remove' });
    }
  };

  const healNow = async (locator) => {
    try {
      const res = await api.post(`/projects/${current.id}/knowledge-base/${locator.id}/heal-now`, {});
      await load();
      if (res.healed?.confidence >= 70) {
        toast.success(`Healed: ${res.healed.strategy} (${res.healed.confidence}%)`, { title: 'KB updated' });
      } else if (res.healed) {
        toast.info(`Low-confidence proposal (${res.healed.confidence}%) — KB unchanged.`);
      } else {
        toast.info('No replacement found in the current DOM.');
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      toast.error(msg, { title: 'Heal failed' });
    }
  };

  if (!current) {
    return (
      <div className="relative flex flex-col h-full overflow-hidden">
        <div className="absolute inset-0 -z-10"><AuroraBackground /></div>
        <PageHeader title="Knowledge Base" />
        <EmptyState
          icon={Brain}
          title="No project selected"
          message="Pick a project to see its Knowledge Base. Each project has its own learned locators."
        />
      </div>
    );
  }

  const isEmpty = !loading && locators.length === 0;

  const subtitle = isEmpty
    ? 'Empty — runs will fill this in'
    : `${stats.total} locator${stats.total === 1 ? '' : 's'} for ${current.name} · ${stats.healthy} healthy · ${stats.watching} watching · ${stats.quarantined} quarantined`;

  return (
    <div className="relative flex flex-col h-full overflow-hidden">
      <div
        className="pointer-events-none"
        style={{ position: 'sticky', top: 0, height: '100dvh', marginBottom: '-100dvh', zIndex: 0 }}
      >
        <AuroraBackground />
      </div>

      <div className="relative z-10">
        <PageHeader title="Knowledge Base" subtitle={subtitle}>
          <Button size="sm" variant="ghost" onClick={load} disabled={loading} title="Reload from the server">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </PageHeader>
      </div>

      <main className="relative z-10 flex-1 overflow-y-auto bg-transparent">
        <div className="max-w-6xl mx-auto px-page py-6 space-y-4">
          {/* Live-capture banner — surfaces real-time growth from a run in
              progress. Auto-dismisses ~12s after the last event. */}
          {liveCaptureCount > 0 && (
            <div className="glass px-4 py-2 flex items-center gap-2 text-sm">
              <Activity className="w-4 h-4 text-success-600 animate-pulse" aria-hidden="true" />
              <span className="font-semibold text-ink-900">Live</span>
              <span className="text-ink-600">
                {liveCaptureCount} locator{liveCaptureCount === 1 ? '' : 's'} captured or updated in this session.
              </span>
              <button
                type="button"
                onClick={() => { setLiveCaptureCount(0); setRecentlyTouched(new Set()); }}
                className="ml-auto text-2xs uppercase tracking-wider text-ink-500 hover:text-ink-800"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Search + filter chips */}
          <section className="glass p-3 flex flex-col gap-3 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400" aria-hidden="true" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by element, selector, role, accessible name, or page URL…"
                className="pl-9"
              />
            </div>
            <div className="flex items-center gap-1">
              <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
                All <span className="text-ink-400 ml-1">{stats.total}</span>
              </FilterChip>
              <FilterChip active={filter === 'watching'} onClick={() => setFilter('watching')}
                          tone={stats.watching > 0 ? 'warn' : null}>
                Watching <span className="ml-1">{stats.watching}</span>
              </FilterChip>
              <FilterChip active={filter === 'quarantined'} onClick={() => setFilter('quarantined')}
                          tone={stats.quarantined > 0 ? 'danger' : null}>
                Quarantined <span className="ml-1">{stats.quarantined}</span>
              </FilterChip>
            </div>
          </section>

          {/* Per-project explainer — visible the first time the page loads,
              dismissable via localStorage so power users don't see it forever. */}
          <ProjectScopeBanner projectName={current.name} />

          {/* Main list / empty state */}
          {loading ? (
            <div className="glass p-6 text-sm text-ink-500">Loading…</div>
          ) : isEmpty ? (
            <div className="glass p-10">
              <EmptyState
                icon={Brain}
                title="Knowledge accumulates as you run"
                message="Each successful test teaches QAAI another locator. Run your first suite from Run Suite to seed this project's KB. Knowledge belongs to this project only — a new website starts empty by design."
              />
            </div>
          ) : groups.length === 0 ? (
            <div className="glass p-10">
              <EmptyState
                icon={Search}
                title="No matches"
                message={query ? `Nothing matches "${query}". Clear the search or filter to see all locators.` : 'No locators match this filter.'}
              />
            </div>
          ) : (
            groups.map((group) => (
              <PageGroup
                key={group.url}
                group={group}
                expandedId={expanded}
                onExpand={setExpanded}
                onRemove={remove}
                onHeal={healNow}
                recentlyTouched={recentlyTouched}
              />
            ))
          )}
        </div>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FilterChip — small pill button used in the filter row. Tone hints at
// urgency: a `watching` chip with content gets the warn tone; an empty
// chip stays neutral.
// ─────────────────────────────────────────────────────────────────────────────
function FilterChip({ active, onClick, tone, children }) {
  let base = 'inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold transition-colors';
  let cls = active
    ? 'bg-ink-900 text-white'
    : 'bg-white/70 backdrop-blur text-ink-700 border border-ink-200 hover:bg-ink-50';
  if (!active && tone === 'warn') cls = 'bg-warn-50 text-warn-700 border border-warn-200 hover:bg-warn-100';
  if (!active && tone === 'danger') cls = 'bg-danger-50 text-danger-700 border border-danger-200 hover:bg-danger-100';
  return (
    <button type="button" onClick={onClick} className={`${base} ${cls}`}>
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProjectScopeBanner — one-line note explaining KB is per-project. Dismissable
// per project via localStorage so seasoned users aren't reminded every visit.
// ─────────────────────────────────────────────────────────────────────────────
function ProjectScopeBanner({ projectName }) {
  const storageKey = `qaai.kb.scopeBanner.dismissed`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });
  if (dismissed) return null;
  return (
    <div className="glass-soft px-4 py-3 flex items-start gap-3 text-sm">
      <HelpCircle className="w-4 h-4 text-info-600 mt-0.5 shrink-0" aria-hidden="true" />
      <div className="flex-1">
        <span className="font-semibold text-ink-900">Knowledge is per-project. </span>
        <span className="text-ink-600">
          These locators were learned from runs of <span className="font-semibold text-ink-800">{projectName}</span>.
          Switching to another project shows a different KB. New projects start empty by design — knowledge from one site can't help a different one.
        </span>
      </div>
      <button
        type="button"
        onClick={() => {
          try { localStorage.setItem(storageKey, '1'); } catch {}
          setDismissed(true);
        }}
        className="text-ink-400 hover:text-ink-700 shrink-0"
        aria-label="Dismiss"
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PageGroup — a folder for one page URL. Collapsible header showing the
// URL + a count of locators inside, and the list of locator rows below.
// ─────────────────────────────────────────────────────────────────────────────
function PageGroup({ group, expandedId, onExpand, onRemove, onHeal, recentlyTouched }) {
  const [open, setOpen] = useState(true);
  const worstHealth = Math.min(...group.locators.map((l) => l.healthScore ?? 100));
  const groupCls = healthClass(worstHealth);
  const meta = HEALTH_META[groupCls];
  return (
    <section className="glass overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-ink-50/40 transition-colors text-left"
      >
        <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        <Globe className="w-3.5 h-3.5 shrink-0 text-info-600" aria-hidden="true" />
        <span className="text-sm font-semibold text-ink-900 truncate" title={group.url}>
          {shortUrl(group.url)}
        </span>
        <span className="text-2xs text-ink-500 ml-1 tabular-nums">{group.locators.length}</span>
        {groupCls !== 'healthy' && (
          <span className={`ml-2 text-2xs uppercase tracking-wider font-bold ${meta.textCls}`}>
            {meta.label}
          </span>
        )}
      </button>
      {open && (
        <ul className="border-t border-ink-100 divide-y divide-ink-100">
          {group.locators.map((l) => (
            <LocatorRow
              key={l.id}
              locator={l}
              expanded={expandedId === l.id}
              onExpand={() => onExpand(expandedId === l.id ? null : l.id)}
              onRemove={() => onRemove(l)}
              onHeal={() => onHeal(l)}
              freshlyCaptured={recentlyTouched.has(l.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LocatorRow — single locator. Compact by default; expansion reveals the
// full intent panel, heal history, and the Used-by footprint.
// ─────────────────────────────────────────────────────────────────────────────
function LocatorRow({ locator, expanded, onExpand, onRemove, onHeal, freshlyCaptured }) {
  const cls = healthClass(locator.healthScore);
  const meta = HEALTH_META[cls];
  const stratMeta = locator.strategy ? STRATEGY_META[locator.strategy] : null;
  const score = locator.healthScore ?? 100;
  const occ = locator.occurrences || 0;
  const lastHealed = formatRelative(locator.lastHealedAt);
  const lastFailed = formatRelative(locator.lastFailedAt);

  return (
    <li className={`relative ${freshlyCaptured ? 'ring-1 ring-success-300 ring-inset bg-success-50/30 animate-pulse' : ''}`}
        style={freshlyCaptured ? { animationIterationCount: 1, animationDuration: '1.2s' } : undefined}>
      <button
        type="button"
        onClick={onExpand}
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-ink-50/40 transition-colors text-left"
      >
        <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-ink-400 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-ink-900 truncate" title={locator.element}>
              {locator.element}
            </span>
            {stratMeta && (
              <span className={`px-1.5 py-0 rounded text-2xs font-bold uppercase tracking-wider border ${stratMeta.cls}`}>
                {stratMeta.label}
              </span>
            )}
            {locator.accessibleName && locator.accessibleName !== locator.element && (
              <span className="text-2xs text-ink-500 truncate" title={locator.accessibleName}>
                "{locator.accessibleName}"
              </span>
            )}
            {occ >= 2 && (
              <span className="inline-flex items-center gap-0.5 text-2xs text-success-700 bg-success-50 border border-success-200 rounded-pill px-1.5 py-0">
                <Check className="w-2.5 h-2.5" aria-hidden="true" />
                Verified
              </span>
            )}
            {freshlyCaptured && (
              <span className="inline-flex items-center gap-0.5 text-2xs text-success-700 bg-success-50 border border-success-200 rounded-pill px-1.5 py-0">
                <Sparkles className="w-2.5 h-2.5" aria-hidden="true" />
                Just captured
              </span>
            )}
          </div>
          {locator.selector && (
            <code className="block text-2xs font-mono text-ink-600 truncate mt-0.5" title={locator.selector}>
              {locator.selector}
            </code>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex flex-col items-end">
            <div className="w-24 h-1.5 bg-ink-100 rounded-pill overflow-hidden">
              <div className={`h-full ${meta.barCls} transition-all`} style={{ width: `${Math.max(2, score)}%` }} />
            </div>
            <span className={`text-2xs font-bold tabular-nums ${meta.textCls} mt-0.5`}>
              {score}
            </span>
          </div>
          <span className="text-2xs text-ink-500 tabular-nums w-12 text-right">
            {occ}×
          </span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1 bg-white/30 backdrop-blur-sm border-t border-ink-100">
          <LocatorDetail
            locator={locator}
            onRemove={onRemove}
            onHeal={onHeal}
            lastHealed={lastHealed}
            lastFailed={lastFailed}
            healthClass={cls}
          />
        </div>
      )}
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LocatorDetail — expanded panel. Real selector with copy, accessibility
// metadata, page URL, heal history, used-by file list, action buttons.
// ─────────────────────────────────────────────────────────────────────────────
function LocatorDetail({ locator, onRemove, onHeal, lastHealed, lastFailed, healthClass: cls }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [healing, setHealing] = useState(false);
  const [copied, setCopied] = useState(false);

  const copySelector = async () => {
    if (!locator.selector) return;
    try {
      await navigator.clipboard.writeText(locator.selector);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {
      toast.error('Browser refused clipboard access.');
    }
  };

  const triggerHeal = async () => {
    setHealing(true);
    try { await onHeal(); } finally { setHealing(false); }
  };

  // Parse heal history if present.
  let history = [];
  if (locator.healHistory) {
    try { const arr = JSON.parse(locator.healHistory); if (Array.isArray(arr)) history = arr; } catch (_) {}
  }
  const usedBy = locator.usedBy || [];
  const showHealCta = cls !== 'healthy' || (locator.failureCount && locator.failureCount > 0);

  return (
    <div className="space-y-4">
      {/* Selector strip — the trust surface. Always visible, with copy. */}
      <div>
        <div className="text-2xs font-bold uppercase tracking-wider text-ink-500 mb-1">Selector</div>
        {locator.selector ? (
          <div className="flex items-center gap-2 bg-ink-900 rounded-md p-2.5">
            <code className="flex-1 font-mono text-xs text-ink-100 break-all">{locator.selector}</code>
            <button
              type="button"
              onClick={copySelector}
              className="shrink-0 inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-ink-300 hover:text-white hover:bg-white/10 px-2 py-1 rounded transition-colors"
              title="Copy the Playwright locator expression"
            >
              {copied ? <Check className="w-3 h-3 text-success-400" /> : <CopyIcon className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : (
          <div className="text-sm text-ink-500 italic">
            Not yet captured. The next run that touches this element will record the actual Playwright expression.
          </div>
        )}
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
        <MetaField label="Intent"          value={locator.intent} />
        <MetaField label="Accessible name" value={locator.accessibleName} />
        <MetaField label="ARIA role"       value={locator.role} />
        <MetaField label="Page URL"        value={locator.pageUrl} mono />
        <MetaField label="Occurrences"     value={locator.occurrences != null ? String(locator.occurrences) : null} />
        <MetaField label="Last healed"     value={lastHealed} />
        {locator.failureCount > 0 && (
          <MetaField label="Failure count" value={String(locator.failureCount)} tone="danger" />
        )}
        {lastFailed && (
          <MetaField label="Last failed"   value={lastFailed} tone="danger" />
        )}
      </div>

      {/* Used by — which Page Object files reference this locator. The
          footprint closes the loop with Output Files: clicking jumps you
          straight to that POM file in the workspace explorer. */}
      {usedBy.length > 0 && (
        <div>
          <div className="text-2xs font-bold uppercase tracking-wider text-ink-500 mb-1.5">
            Used by
          </div>
          <ul className="space-y-1">
            {usedBy.map((relPath) => (
              <li key={relPath}>
                <button
                  type="button"
                  onClick={() => navigate(`/output-files`)}
                  className="inline-flex items-center gap-1.5 text-xs text-info-700 hover:text-info-900 hover:underline underline-offset-2"
                  title={`Open ${relPath} in Output Files`}
                >
                  <FileCode className="w-3 h-3" aria-hidden="true" />
                  {relPath}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Heal history */}
      {history.length > 0 && (
        <div>
          <div className="text-2xs font-bold uppercase tracking-wider text-ink-500 mb-1.5">
            Heal history
          </div>
          <ul className="space-y-1 text-xs">
            {history.slice(-5).reverse().map((h, i) => (
              <li key={i} className="flex items-center gap-2 text-ink-700">
                <Wand2 className="w-3 h-3 text-accent-600 shrink-0" aria-hidden="true" />
                <span className="font-mono text-ink-500 tabular-nums">{formatRelative(h.ts) || h.ts}</span>
                <span className="text-ink-600 truncate">{h.reason || 'heal attempt'}</span>
                {typeof h.confidence === 'number' && (
                  <span className="ml-auto text-2xs font-bold text-accent-700 tabular-nums">
                    {h.confidence}%
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Action row — Heal-now only when the row has actually had problems.
          A healthy 100-score locator gets nothing actionable here; that's
          intentional per the "no busywork" rule. */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {showHealCta && (
          <Button
            size="sm"
            variant="secondary"
            onClick={triggerHeal}
            disabled={healing}
            loading={healing}
            title="Open a fresh browser to the page and ask the AI to find this element in the live DOM"
          >
            <Wand2 className="w-3.5 h-3.5" />
            Heal from current DOM
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onRemove}
          className="!text-danger-700 hover:!bg-danger-50"
          title="Remove this locator. The next successful run that touches the element will recapture it from scratch."
        >
          <Trash2 className="w-3.5 h-3.5" />
          Remove
        </Button>
      </div>
    </div>
  );
}

function MetaField({ label, value, tone, mono }) {
  return (
    <div>
      <div className="text-2xs font-bold uppercase tracking-wider text-ink-500">{label}</div>
      {value ? (
        <div
          className={`${mono ? 'font-mono text-xs' : 'text-sm'} ${tone === 'danger' ? 'text-danger-700' : 'text-ink-800'} mt-0.5 break-all`}
          title={value}
        >
          {value}
        </div>
      ) : (
        <div className="text-sm text-ink-400 italic mt-0.5">Not available</div>
      )}
    </div>
  );
}
