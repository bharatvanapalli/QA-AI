import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Terminal,
  Trash2,
  Play,
  ChevronRight,
  Loader2,
  Search,
  Copy,
  Check,
  Pause,
  ArrowDownToLine,
} from 'lucide-react';
import api from '../lib/apiClient';
import { useProject } from '../store/project';
import { useRunStream } from '../store/runStream';
import { useToast } from '../lib/useToast';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import StatusBadge from '../components/ui/StatusBadge';

// ── Level classification ────────────────────────────────────────────
// Heuristic mapping from a log line to a level. Lines come from the server
// as free-form strings (server/services/runs.js + playwright-worker.js)
// using a small set of leading glyphs / vocabulary. This stays a client-side
// concern so we don't have to flow structured levels through the WS
// protocol — and so old log history (still all strings) still classifies.
const LEVELS = {
  error: {
    label: 'Errors',
    test: (l) =>
      /^CRITICAL\b|^\s*ERROR\b|\berror:/i.test(l) ||
      l.includes('❌') ||
      /\bcrashed\b|\bfatal\b/i.test(l),
    rowClass: 'text-danger-300',
    chipClass: 'bg-danger-50 text-danger-700 border-danger-200',
    activeClass: 'bg-danger-100 text-danger-900 border-danger-400',
  },
  warn: {
    label: 'Warnings',
    test: (l) => l.includes('⚠') || /\bwarn(ing)?\b/i.test(l) || /\bblocked\b/i.test(l),
    rowClass: 'text-warn-300',
    chipClass: 'bg-warn-50 text-warn-700 border-warn-200',
    activeClass: 'bg-warn-100 text-warn-900 border-warn-400',
  },
  pass: {
    label: 'Passes',
    test: (l) => l.includes('✅') || /\bpassed\b/i.test(l),
    rowClass: 'text-success-300',
    chipClass: 'bg-success-50 text-success-700 border-success-200',
    activeClass: 'bg-success-100 text-success-900 border-success-400',
  },
  phase: {
    label: 'Phases',
    test: (l) =>
      l.startsWith('▶') ||
      l.includes('🚀') ||
      l.includes('📝') ||
      l.startsWith('SUITE COMPLETE') ||
      /^\[(phase|agent)\]/i.test(l),
    rowClass: 'text-info-200',
    chipClass: 'bg-info-50 text-info-700 border-info-200',
    activeClass: 'bg-info-100 text-info-900 border-info-400',
  },
};

function classify(line) {
  if (!line) return 'info';
  for (const key of ['error', 'warn', 'phase', 'pass']) {
    if (LEVELS[key].test(line)) return key;
  }
  return 'info';
}

const ORDERED_LEVELS = ['phase', 'pass', 'warn', 'error'];

export default function ExecutionLog() {
  const navigate = useNavigate();
  const toast = useToast();
  const { current, currentSprintId } = useProject();
  const { log, running, connected, clearLog, latestRunId, latestSummary } = useRunStream();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [activeLevels, setActiveLevels] = useState(() => new Set()); // empty = all
  const [query, setQuery] = useState('');

  // Auto-scroll: a true streaming console pins to the bottom by default,
  // but pauses the moment the user scrolls up to inspect earlier output.
  // We auto-resume when they scroll back within 24px of the bottom.
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!current) {
      setLoading(false);
      setHistory([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const sprintQs = currentSprintId ? `&sprintId=${currentSprintId}` : '';
        const res = await api.get(`/runs?projectId=${current.id}&limit=20${sprintQs}`);
        if (!cancelled) setHistory(res.runs || []);
      } catch (_) {
        if (!cancelled) setHistory([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current?.id, currentSprintId, latestRunId, latestSummary]);

  // Counts per level — drives the chip badge numbers. Recomputed on every
  // log change; cheap since `log` is capped at 500 lines client-side.
  const counts = useMemo(() => {
    const c = { phase: 0, pass: 0, warn: 0, error: 0, info: 0 };
    for (const line of log) c[classify(line)]++;
    return c;
  }, [log]);

  // Filtered + classified view used by the render. Each entry is the
  // original index (so keys stay stable when filters change) + the level.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const wantSet = activeLevels.size === 0 ? null : activeLevels;
    const rows = [];
    for (let i = 0; i < log.length; i++) {
      const line = log[i];
      const lvl = classify(line);
      if (wantSet && !wantSet.has(lvl)) continue;
      if (q && !line.toLowerCase().includes(q)) continue;
      rows.push({ i, line, lvl });
    }
    return rows;
  }, [log, query, activeLevels]);

  // Track whether the user is parked near the bottom. When they scroll up,
  // we stop auto-scrolling so streaming doesn't yank their reading position.
  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(nearBottom);
  }, []);

  // Auto-scroll to bottom on new lines — only if the user hasn't scrolled
  // away. Also pin to bottom when a new run starts so the previous parked
  // position doesn't strand the user above the new output.
  useEffect(() => {
    if (!autoScroll) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered.length, autoScroll]);

  // Reset filters when project changes — old filters might match no lines
  // in the new project's stream and confuse the user.
  useEffect(() => {
    setActiveLevels(new Set());
    setQuery('');
  }, [current?.id]);

  const toggleLevel = (lvl) => {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(lvl)) next.delete(lvl);
      else next.add(lvl);
      return next;
    });
  };

  const clearFilters = () => {
    setActiveLevels(new Set());
    setQuery('');
  };

  const handleCopy = useCallback(async () => {
    // Copy the *currently visible* (filtered) lines so a user who filtered
    // down to errors can paste just the errors. Falls back to the full
    // log when no filter is active.
    const lines = filtered.length ? filtered.map((r) => r.line) : log;
    const text = lines.join('\n');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success(`${lines.length} line${lines.length === 1 ? '' : 's'} copied.`, {
        title: 'Copied to clipboard',
      });
    } catch (err) {
      toast.error(err?.message || 'Could not copy to clipboard.');
    }
  }, [filtered, log, toast]);

  const jumpToBottom = () => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAutoScroll(true);
  };

  const hiddenCount = log.length - filtered.length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Execution Log"
        subtitle={
          running
            ? 'Run in progress…'
            : connected
            ? 'Live stream connected'
            : 'Stream disconnected — reconnecting…'
        }
      >
        <Button
          size="sm"
          variant="secondary"
          onClick={handleCopy}
          disabled={!log.length}
          title={
            filtered.length === log.length || activeLevels.size === 0
              ? 'Copy full log to clipboard'
              : `Copy ${filtered.length} filtered line(s) to clipboard`
          }
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" variant="ghost" onClick={clearLog} disabled={!log.length}>
          <Trash2 className="w-3.5 h-3.5" />
          Clear log
        </Button>
      </PageHeader>

      {/* Filter bar — level chips + search. */}
      <div className="border-b border-ink-200 bg-white px-4 py-2.5 flex items-center gap-2 flex-wrap">
        {ORDERED_LEVELS.map((lvl) => {
          const meta = LEVELS[lvl];
          const active = activeLevels.has(lvl);
          const n = counts[lvl];
          return (
            <button
              key={lvl}
              type="button"
              onClick={() => toggleLevel(lvl)}
              className={`inline-flex items-center gap-1.5 px-2.5 h-7 rounded-pill text-2xs font-semibold border transition-colors ${
                active ? meta.activeClass : meta.chipClass
              } hover:brightness-95`}
              aria-pressed={active}
              title={`Show only ${meta.label.toLowerCase()}`}
            >
              <span>{meta.label}</span>
              <span className="tabular-nums opacity-80">{n}</span>
            </button>
          );
        })}
        {activeLevels.size > 0 && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-2xs font-semibold text-ink-500 hover:text-ink-900 underline-offset-2 hover:underline"
          >
            Clear filters
          </button>
        )}
        <div className="relative flex-1 max-w-md min-w-[200px] ml-auto">
          <Search
            className="w-3.5 h-3.5 text-ink-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search log lines…"
            className="w-full h-8 pl-8 pr-3 text-xs border border-ink-200 rounded-md focus:outline-none focus:border-ink-900 focus:shadow-ring"
            aria-label="Search log lines"
          />
        </div>
      </div>

      <main className="flex-1 grid grid-cols-[1fr_320px] overflow-hidden bg-ink-50">
        {/* Live log */}
        <section className="overflow-hidden flex flex-col p-4 relative">
          <div className="flex items-center gap-2 mb-2 text-xs text-ink-500">
            <Terminal className="w-3.5 h-3.5" />
            <span>Streaming output</span>
            <span
              className={`ml-2 w-1.5 h-1.5 rounded-full ${
                connected ? 'bg-success-500 animate-pulse' : 'bg-danger-500'
              }`}
            />
            {running && <Loader2 className="w-3 h-3 animate-spin ml-2" />}
            {hiddenCount > 0 && (
              <span className="ml-auto text-2xs text-ink-400 italic">
                {hiddenCount} line{hiddenCount === 1 ? '' : 's'} hidden by filters
              </span>
            )}
            {!autoScroll && log.length > 0 && (
              <span className={`inline-flex items-center gap-1 text-2xs text-warn-700 ${hiddenCount > 0 ? '' : 'ml-auto'}`}>
                <Pause className="w-3 h-3" />
                Scroll paused
              </span>
            )}
          </div>
          <div
            ref={logRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto rounded-lg bg-ink-900 text-ink-200 font-mono text-xs p-3 leading-relaxed"
          >
            {log.length === 0 ? (
              <div className="text-ink-500 italic">
                {connected
                  ? 'Idle — start a run from the Test Cases page to see live output.'
                  : 'Not connected. Sign in or check the server.'}
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-ink-500 italic">
                No lines match the current filters.{' '}
                <button
                  type="button"
                  onClick={clearFilters}
                  className="underline hover:text-ink-200"
                >
                  Clear filters
                </button>
                .
              </div>
            ) : (
              filtered.map(({ i, line, lvl }) => (
                <div key={i} className={LEVELS[lvl]?.rowClass || 'text-ink-200'}>
                  {line}
                </div>
              ))
            )}
          </div>
          {/* Jump-to-bottom floating control when scroll is paused. */}
          {!autoScroll && log.length > 0 && (
            <button
              type="button"
              onClick={jumpToBottom}
              className="absolute right-7 bottom-7 inline-flex items-center gap-1.5 px-3 h-8 rounded-pill text-2xs font-semibold bg-ink-900 text-white border border-ink-700 shadow-pop hover:bg-ink-800"
              title="Resume auto-scroll and jump to newest"
            >
              <ArrowDownToLine className="w-3 h-3" />
              Jump to latest
            </button>
          )}
        </section>

        {/* History panel */}
        <aside className="border-l border-ink-200 bg-white overflow-y-auto p-4">
          <h2 className="text-xs font-bold text-ink-700 uppercase tracking-wider mb-3">
            Recent runs
          </h2>
          {loading ? (
            <div className="text-xs text-ink-500">Loading…</div>
          ) : history.length === 0 ? (
            <EmptyState
              icon={Play}
              title="No runs yet"
              message="Approve test cases and click Run to begin."
            />
          ) : (
            <div className="space-y-2">
              {history.map((r) => (
                <button
                  key={r.id}
                  onClick={() => navigate(`/reports?runId=${r.id}`)}
                  className="w-full text-left rounded-md border border-ink-200 p-2.5 hover:bg-ink-50"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-ink-900 truncate">
                      {r.sprintName}
                    </span>
                    <StatusBadge
                      status={
                        r.status === 'completed'
                          ? 'valid'
                          : r.status === 'failed' || r.status === 'cancelled'
                          ? 'invalid'
                          : 'validating'
                      }
                      label={r.status}
                    />
                  </div>
                  <div className="text-xs text-ink-500 mt-0.5 flex items-center justify-between">
                    <span>
                      ✅ {r.passed} · ❌ {r.failed} · ⛔ {r.blocked ?? 0}
                      {(r.skipped ?? 0) > 0 ? ` · ⏭ ${r.skipped}` : ''}
                    </span>
                    <ChevronRight className="w-3 h-3" />
                  </div>
                  <div className="text-2xs text-ink-400 mt-0.5">
                    {new Date(r.startedAt).toLocaleString()}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
