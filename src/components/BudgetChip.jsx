import React, { useEffect, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import api from '../lib/apiClient';
import { useAuth } from '../store/auth';

/**
 * Per-user daily token-budget chip (Phase E10.3, retuned in Phase F).
 *
 * Sits in PageHeader. Hidden by default to stay out of the operator's
 * way — only appears once today's usage crosses 40 %% of the ceiling.
 *
 * State thresholds (revised after the 3.5M-token sample-run forensics —
 * one run was ~70%% of the 5M daily ceiling, so the prior 80%% warn
 * threshold left no room to react):
 *   pct  <  40  → hidden entirely (no chip, no clutter)
 *   40  ≤ pct < 60 → info chip   ("you're using more than usual today")
 *   60  ≤ pct < 85 → warn chip  ("approaching daily ceiling — switch to Fast mode")
 *   pct  ≥ 85   → danger chip  (urgent — one more run may exhaust the budget)
 *   pct  ≥ 100  → blocked       ("calls refused until UTC midnight")
 *
 * Polls every 30s — cheap (one indexed PK lookup) and not real-time
 * critical. The chip is for awareness, not for race-condition gating.
 *
 * On click: small popover with the per-provider breakdown and the
 * UTC reset countdown. No inline edit — limit changes happen in
 * Settings (PUT /api/budget/limit) per "nothing should be forced".
 */
const POLL_MS = 30_000;

function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCountdown(resetIso) {
  if (!resetIso) return '';
  const ms = new Date(resetIso).getTime() - Date.now();
  if (ms <= 0) return 'resets soon';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function BudgetChip() {
  const { status: authStatus } = useAuth();
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  useEffect(() => {
    if (authStatus !== 'authed' || suspended) {
      setStatus(null);
      setOpen(false);
      return undefined;
    }
    let alive = true;
    let timer = null;
    const refresh = async () => {
      const { ok, data, error } = await api.safe.get('/budget/status');
      if (!alive) return;
      if (ok) {
        setStatus(data);
        return;
      }
      if (error?.isAuth) {
        setStatus(null);
        setOpen(false);
        setSuspended(true);
      }
    };
    refresh();
    timer = setInterval(refresh, POLL_MS);
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [authStatus, suspended]);

  useEffect(() => {
    if (authStatus === 'authed') return;
    setSuspended(false);
  }, [authStatus]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (!btnRef.current?.contains(e.target) && !popRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Hidden states: no data, unlimited budget, or usage below 40 %.
  if (!status) return null;
  if (status.unlimited) return null;
  if ((status.pct || 0) < 40) return null;

  const pct = status.pct || 0;
  const enforced = !!status.enforced;
  const isBlocked  = enforced && pct >= 100;
  const isDanger   = pct >= 85;
  const isWarn     = pct >= 60;
  const cls = isBlocked
    ? 'bg-danger-50 text-danger-700 border-danger-200 hover:bg-danger-100'
    : isDanger
    ? 'bg-danger-50 text-danger-700 border-danger-200 hover:bg-danger-100'
    : isWarn
    ? 'bg-warn-50 text-warn-700 border-warn-200 hover:bg-warn-100'
    : 'bg-info-50 text-info-700 border-info-100 hover:bg-info-100';

  const label = isBlocked
    ? 'Budget reached'
    : pct >= 100
    ? 'Usage high'
    : `${pct}% of daily`;

  const providers = Object.entries(status.perProvider || {}).filter(([k]) => k !== 'system');

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition ${cls}`}
        title={`Daily token budget — ${fmtNum(status.used)} / ${fmtNum(status.limit)} used`}
      >
        <Gauge size={12} />
        <span>{label}</span>
      </button>
      {open && (
        <div
          ref={popRef}
          className="absolute right-0 top-full mt-2 w-72 bg-white border border-ink-200 rounded-lg shadow-lg p-3 z-30"
        >
          <div className="text-xs font-semibold text-ink-900 mb-2">Daily token budget</div>
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-lg font-semibold text-ink-900">{fmtNum(status.used)}</span>
            <span className="text-xs text-ink-500">/ {fmtNum(status.limit)} tokens</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-ink-100 overflow-hidden mb-3">
            <div
              className={isBlocked || isDanger ? 'h-full bg-danger-500' : isWarn ? 'h-full bg-warn-500' : 'h-full bg-info-500'}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          {!isBlocked && (isWarn || isDanger) && (
            <div className={`text-[11px] rounded px-2 py-1.5 mb-2 ${isDanger ? 'bg-danger-50 border border-danger-200 text-danger-700' : 'bg-warn-50 border border-warn-200 text-warn-700'}`}>
              {!enforced && pct >= 100
                ? 'Usage is above the local daily monitor. QAAI will keep running; your API provider quota is the real limit.'
                : isDanger
                ? 'Approaching the daily ceiling. One more run may exhaust the budget — review Project Setup → Execution mode and consider Fast.'
                : 'Above 60% of daily budget. If you have many runs queued, switch projects to Fast mode in Project Setup.'}
            </div>
          )}
          {providers.length > 0 && (
            <div className="space-y-1 mb-3">
              {providers.map(([name, p]) => (
                <div key={name} className="flex items-center justify-between text-xs">
                  <span className="text-ink-600 capitalize">{name}</span>
                  <span className="text-ink-900 tabular-nums">{fmtNum(p.tokens)} <span className="text-ink-400">({p.calls})</span></span>
                </div>
              ))}
            </div>
          )}
          {isBlocked && (
            <div className="text-xs text-danger-700 bg-danger-50 border border-danger-100 rounded px-2 py-1.5 mb-2">
              New AI calls are blocked until your budget resets. Raise your limit in Settings → AI Provider, or wait for UTC midnight.
            </div>
          )}
          {status.blockedToday > 0 && enforced && (
            <div className="text-xs text-ink-500 mb-2">
              {status.blockedToday} call{status.blockedToday === 1 ? '' : 's'} refused today.
            </div>
          )}
          <div className="text-xs text-ink-500 flex items-center justify-between">
            <span>Resets in</span>
            <span className="font-medium text-ink-700">{fmtCountdown(status.resetAt)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
