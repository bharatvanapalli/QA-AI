import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  motion,
  MotionConfig,
  useMotionValue,
  useTransform,
  animate as animateMotion,
  useReducedMotion,
} from 'framer-motion';
import {
  Play,
  ArrowUpRight,
  Activity,
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Target,
  GitPullRequest,
  Sparkles,
  ChevronRight,
  Scale,
  ArrowLeftRight,
} from 'lucide-react';
import api from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import { useRunStream } from '../store/runStream';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import Skeleton from '../components/ui/Skeleton';

/* ─────────────────────────────────────────────────────────────────────────────
 * Aurora Glass — QAAI Overview, V2
 *
 * Aesthetic commitment: light aurora gradient atmosphere behind frosted glass
 * surfaces. Radial gauges replace stacked bars. Gradient area chart with glow
 * replaces the sparkline. One orchestrated framer-motion entrance.
 *
 * Reads the same /dashboard/:projectId + /projects/:p/sprints/:s/health
 * endpoints as the current Overview. No backend changes.
 * ──────────────────────────────────────────────────────────────────────────── */

// Status → token-aligned hex for Recharts (which needs raw colors, not classes).
// Matches the project's success/danger/warn/info/accent palette.
const SIGNAL = {
  success: '#10b981', // success-500
  danger:  '#ef4444', // danger-500
  warn:    '#f59e0b', // warn-500
  info:    '#3b82f6', // info-500
  accent:  '#8b5cf6', // accent-500
  ink:     '#9aa3b4', // ink-400 (pending / neutral)
};

const VERDICT_META = {
  GO:           { word: 'Ship it.',  tone: 'success', sub: 'All systems green. Release is recommended.' },
  NO_GO:        { word: 'Hold.',     tone: 'danger',  sub: 'Critical failures are blocking release.' },
  LOW_COVERAGE: { word: 'Wait.',     tone: 'warn',    sub: 'Not enough has been measured to make a call.' },
  NO_DATA:      { word: 'Begin.',    tone: 'info',    sub: 'Pull requirements and run the suite to start.' },
};

const TONE_TEXT = {
  success: 'text-success-700',
  danger:  'text-danger-700',
  warn:    'text-warn-700',
  info:    'text-info-700',
  accent:  'text-accent-700',
};

const TONE_HEX = {
  success: SIGNAL.success,
  danger:  SIGNAL.danger,
  warn:    SIGNAL.warn,
  info:    SIGNAL.info,
  accent:  SIGNAL.accent,
};

// Recharts' RadialBar renders a visible "tail" / endpoint overshoot at exactly
// value=100 when cornerRadius > 0 — the rounded end-cap clips outside the ring.
// Capping the chart input at 99.5 makes the visual indistinguishable from a
// full ring while avoiding the glitch. The displayed text label still reads
// the true value (passed as a separate prop).
// ─────────────────────────────────────────────────────────────────────────────
// AuroraBackground — three slow-moving radial orbs + grain overlay. Fixed
// position so the surface stays alive even while the user scrolls.
// ─────────────────────────────────────────────────────────────────────────────
function AuroraBackground() {
  return (
    <div className="aurora-canvas grain-overlay" aria-hidden="true">
      <div className="aurora-orb aurora-orb-accent  aurora-drift-1"
           style={{ width: '52vw', height: '52vw', top: '-10vw', left: '-6vw' }} />
      <div className="aurora-orb aurora-orb-info    aurora-drift-2"
           style={{ width: '46vw', height: '46vw', top: '-4vw', right: '-8vw', opacity: 0.5 }} />
      <div className="aurora-orb aurora-orb-success aurora-drift-3"
           style={{ width: '42vw', height: '42vw', bottom: '-22vw', left: '10vw', opacity: 0.28 }} />
      <div className="aurora-orb aurora-orb-warn    aurora-drift-1"
           style={{ width: '34vw', height: '34vw', bottom: '-10vw', right: '8vw', opacity: 0.32 }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AnimatedNumber — counts up on enter using framer-motion. Respects
// prefers-reduced-motion (snaps to target instead of animating).
// ─────────────────────────────────────────────────────────────────────────────
function AnimatedNumber({ value, suffix = '', duration = 0.18, decimals = 0 }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(0);
  const display = useTransform(mv, (v) =>
    decimals > 0 ? v.toFixed(decimals) : Math.round(v).toLocaleString()
  );

  useEffect(() => {
    if (reduce) {
      mv.set(value || 0);
      return;
    }
    const controls = animateMotion(mv, value || 0, {
      duration,
      ease: [0.22, 1, 0.36, 1],
    });
    return controls.stop;
  }, [value, duration, reduce, mv]);

  return (
    <span className="tabular-nums">
      <motion.span>{display}</motion.span>
      {suffix}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HeroVerdict — the centerpiece. Large radial pass-rate gauge on the left,
// big italic verdict word + reason on the right.
// ─────────────────────────────────────────────────────────────────────────────
function HeroVerdict({ stats, trendValues, onReRun }) {
  const recommendation = stats?.recommendation || 'NO_DATA';
  const meta = VERDICT_META[recommendation] || VERDICT_META.NO_DATA;
  const passRate = typeof stats?.stabilityPercent === 'number' ? stats.stabilityPercent : 0;
  const ringHex = TONE_HEX[meta.tone];
  const ringDegrees = Math.max(0, Math.min(100, passRate)) * 3.6;

  // Recharts wants a tuple — one bar for the value, one ghost for the
  // remaining track. The track sits behind the value via the same chart
  // but a softer fill.
  const trendDelta = useMemo(() => {
    if (!trendValues || trendValues.length < 2) return null;
    return trendValues[trendValues.length - 1] - trendValues[0];
  }, [trendValues]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="glass relative overflow-hidden p-5 md:p-6"
    >
      <div className="grid lg:grid-cols-[164px_1fr] gap-5 lg:gap-7 items-center">
        {/* The gauge */}
        <div className="relative h-[154px] min-w-[154px] flex items-center justify-center">
          <div
            className="h-[154px] w-[154px] rounded-full p-3"
            style={{
              background: `conic-gradient(${ringHex} ${ringDegrees}deg, rgba(15, 23, 42, 0.08) 0deg)`,
            }}
            aria-hidden="true"
          >
            <div className="h-full w-full rounded-full bg-white/85 backdrop-blur-sm shadow-inner" />
          </div>
          {/* Numerals + label centered inside the ring */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <div className={`text-4xl font-extrabold tracking-tight ${TONE_TEXT[meta.tone]}`}>
              <AnimatedNumber value={passRate} suffix="%" />
            </div>
            <div className="text-2xs uppercase tracking-[0.18em] font-bold text-ink-500 mt-1">
              Pass rate
            </div>
          </div>
        </div>

        {/* The verdict */}
        <div className="min-w-0">
          <div className="text-2xs uppercase tracking-[0.22em] font-bold text-ink-500 mb-3 flex items-center gap-1.5">
            <Sparkles className="w-3 h-3" />
            AI Release recommendation
          </div>
          <motion.h2
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08, duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className={`font-display text-[56px] md:text-[64px] leading-none tracking-tight ${TONE_TEXT[meta.tone]}`}
          >
            {meta.word}
          </motion.h2>
          <p className="mt-3 text-sm text-ink-700 max-w-2xl">
            {stats?.recommendationReason || meta.sub}
          </p>

          <div className="mt-4 flex items-center gap-2.5 flex-wrap">
            {stats?.testCases > 0 && (
              <Chip label={`${stats.passed ?? 0} / ${stats.testCases} passing`} tone={meta.tone} />
            )}
            {trendDelta !== null && trendDelta !== 0 && (
              <Chip
                label={`${trendDelta > 0 ? '↑' : '↓'} ${Math.abs(trendDelta)} pp vs first run`}
                tone={trendDelta > 0 ? 'success' : 'danger'}
              />
            )}
            {stats?.blocked > 0 && (
              <Chip label={`${stats.blocked} blocked`} tone="warn" />
            )}
            <button
              type="button"
              onClick={onReRun}
              className="ml-auto inline-flex items-center gap-2 px-4 h-9 rounded-pill bg-ink-900 text-white text-sm font-semibold hover:bg-ink-800 transition-colors focus-visible:outline-none focus-visible:shadow-ring"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              Re-run suite
            </button>
          </div>
        </div>

      </div>
    </motion.section>
  );
}

function Chip({ label, tone = 'info' }) {
  const tones = {
    success: 'bg-success-50/70 text-success-700 border-success-200/60',
    danger:  'bg-danger-50/70 text-danger-700 border-danger-200/60',
    warn:    'bg-warn-50/70 text-warn-700 border-warn-200/60',
    info:    'bg-info-50/70 text-info-700 border-info-200/60',
    accent:  'bg-accent-50/70 text-accent-700 border-accent-200/60',
  };
  return (
    <span className={`inline-flex items-center text-xs font-semibold px-3 h-7 rounded-pill border backdrop-blur-sm ${tones[tone]}`}>
      {label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GlassKPI — glass card with animated counter and a tiny radial accent.
// ─────────────────────────────────────────────────────────────────────────────
function ProgressTrack({ value, tone = 'info', label }) {
  const safeValue = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const fills = {
    success: 'bg-success-500',
    danger: 'bg-danger-500',
    warn: 'bg-warn-500',
    info: 'bg-info-500',
    accent: 'bg-accent-500',
    ink: 'bg-ink-400',
  };
  return (
    <div className="mt-3" aria-label={label || `${safeValue}%`}>
      <div className="h-1.5 overflow-hidden rounded-full bg-ink-100/80">
        <div
          className={`h-full rounded-full ${fills[tone] || fills.info}`}
          style={{ width: `${safeValue}%` }}
        />
      </div>
    </div>
  );
}

function GlassKPI({ icon: Icon, label, value, tone, sublabel, delta, deltaTone, onClick, ringPct, suffix = '' }) {
  const tones = {
    success: { bar: SIGNAL.success, txt: TONE_TEXT.success, sub: 'text-success-600' },
    danger:  { bar: SIGNAL.danger,  txt: TONE_TEXT.danger,  sub: 'text-danger-600'  },
    warn:    { bar: SIGNAL.warn,    txt: TONE_TEXT.warn,    sub: 'text-warn-600'    },
    info:    { bar: SIGNAL.info,    txt: TONE_TEXT.info,    sub: 'text-info-600'    },
    accent:  { bar: SIGNAL.accent,  txt: TONE_TEXT.accent,  sub: 'text-accent-600'  },
  };
  const t = tones[tone];
  const Wrapper = onClick ? 'button' : 'div';
  const hasProgress = typeof ringPct === 'number';

  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`glass glass-hover text-left p-4 w-full block relative focus-visible:outline-none focus-visible:shadow-ring ${onClick ? 'cursor-pointer' : ''}`}
    >
      <div>
        <div className="text-2xs uppercase tracking-[0.16em] font-bold text-ink-500 mb-3 flex items-center gap-1.5">
          <Icon className="w-3 h-3" />
          {label}
        </div>
        <div className={`text-[34px] font-extrabold leading-none tracking-tight ${t.txt}`}>
          <AnimatedNumber value={typeof value === 'number' ? value : 0} suffix={suffix} />
        </div>
        {sublabel && <div className="text-2xs text-ink-500 mt-2 tabular-nums">{sublabel}</div>}
        {delta && (
          <div className={`text-2xs font-semibold mt-1 ${deltaTone === 'good' ? 'text-success-600' : deltaTone === 'bad' ? 'text-danger-600' : 'text-ink-500'}`}>
            {delta}
          </div>
        )}
        {hasProgress && <ProgressTrack value={ringPct} tone={tone} label={`${label}: ${ringPct}%`} />}
      </div>
    </Wrapper>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ModuleHealthRadial — replaces StackedBar. A grid of mini radial gauges
// per module, each showing pass ratio. Click drills into Test Cases filtered
// to that module.
// ─────────────────────────────────────────────────────────────────────────────
function ModuleHealthRadial({ modules, onModuleClick }) {
  // Sort: regressing first (low pass rate, high traffic), stable green at end.
  const ranked = useMemo(() => {
    if (!modules) return [];
    return modules
      .map((m) => {
        const denom = m.pass + m.fail + m.blocked;
        const rate = denom > 0 ? Math.round((m.pass / denom) * 100) : null;
        return { ...m, denom, rate };
      })
      .sort((a, b) => {
        if (a.rate == null && b.rate != null) return 1;
        if (a.rate != null && b.rate == null) return -1;
        if (a.rate == null && b.rate == null) return 0;
        return a.rate - b.rate;
      });
  }, [modules]);

  if (!ranked.length) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15, duration: 0.6 }}
      className="glass p-6 md:p-7"
    >
      <div className="flex items-end justify-between mb-5 flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-semibold text-ink-900 tracking-tight">
            Module health
            <span className="ml-2 text-sm font-normal text-ink-500 tabular-nums">
              · {ranked.length} module{ranked.length === 1 ? '' : 's'}
            </span>
          </h2>
          <p className="text-sm text-ink-500 mt-0.5">
            Pass ratio per module · click to drill in
            {ranked.length > 12 && <span className="text-ink-400"> · scroll for more</span>}
          </p>
        </div>
        <Legend />
      </div>

      {/* Cap the gauge grid at 70vh so a project with 40+ modules doesn't push
          Recent runs miles off-screen. Internal scroll keeps the card compact;
          the sticky TrendChart in the sibling column follows the page scroll. */}
      <div
        className="grid gap-4 max-h-[70vh] overflow-y-auto pr-2 -mr-2"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}
      >
        {ranked.map((m, i) => (
          <ModuleGauge key={m.module} module={m} index={i} onClick={() => onModuleClick(m.module)} />
        ))}
      </div>
    </motion.section>
  );
}

function ModuleGauge({ module, index, onClick }) {
  const { rate, pass, fail, blocked, denom } = module;
  const tone = rate == null ? 'ink' : rate >= 80 ? 'success' : rate >= 50 ? 'warn' : 'danger';
  return (
    <motion.button
      type="button"
      onClick={onClick}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: Math.min(0.12 + index * 0.015, 0.24), duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="glass-soft glass-hover p-3.5 text-left focus-visible:outline-none focus-visible:shadow-ring"
      title={denom > 0 ? `${pass} pass · ${fail} fail · ${blocked} blocked` : 'No activity yet'}
    >
      <div className="relative h-8 flex items-center">
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={`text-base font-bold tabular-nums ${TONE_TEXT[tone] || 'text-ink-500'}`}>
            {rate == null ? '—' : `${rate}%`}
          </span>
        </div>
      </div>
      <div
        className="text-sm font-semibold text-ink-800 w-full text-center leading-snug break-words"
        title={module.module}
        style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
      >
        {module.module}
      </div>
      <div className="text-2xs text-ink-500 tabular-nums">
        {denom > 0 ? `${pass}/${denom} pass` : 'no activity'}
      </div>
      <ProgressTrack value={rate ?? 0} tone={tone} label={`${module.module}: ${rate ?? 0}% pass rate`} />
    </motion.button>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-xs text-ink-500">
      <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-success-500" /> ≥ 80%</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-warn-500" /> 50–79%</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-danger-500" /> &lt; 50%</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-ink-300" /> no activity</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TrendChart — Recharts AreaChart with a gradient fill and glow filter.
// Replaces the Sparkline. Shows pass-rate trend across recent runs.
// ─────────────────────────────────────────────────────────────────────────────
function TrendChart({ values }) {
  if (!values || values.length === 0) {
    return (
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.6 }}
        className="glass p-6 md:p-7 flex flex-col items-center justify-center min-h-[260px] text-center lg:sticky lg:top-6"
      >
        <Activity className="w-6 h-6 text-ink-300 mb-3" />
        <h2 className="text-xl font-semibold text-ink-900 tracking-tight">Pass-rate trend</h2>
        <p className="text-sm text-ink-500 mt-1 max-w-xs">
          No measured runs yet. Start a run to see how pass rate evolves.
        </p>
      </motion.section>
    );
  }
  const data = values.map((v, i) => ({ idx: i, rate: v }));
  const last = values[values.length - 1];
  const first = values[0];
  const delta = last - first;
  const variance = Math.max(...values) - Math.min(...values);
  const isFlat = variance === 0;
  const tone = delta > 0 ? 'success' : delta < 0 ? 'danger' : isFlat && last >= 80 ? 'success' : isFlat && last < 50 ? 'danger' : 'info';
  const hex = SIGNAL[tone];
  const chart = { w: 320, h: 140, left: 16, right: 16, top: 14, bottom: 20 };
  const plotW = chart.w - chart.left - chart.right;
  const plotH = chart.h - chart.top - chart.bottom;
  const points = values.map((v, i) => {
    const x = chart.left + (values.length === 1 ? plotW / 2 : (i / (values.length - 1)) * plotW);
    const y = chart.top + (1 - Math.max(0, Math.min(100, v)) / 100) * plotH;
    return { x, y, value: v };
  });
  const linePoints = points.map((p) => `${p.x},${p.y}`).join(' ');
  const areaPath = points.length
    ? `M ${points[0].x} ${chart.h - chart.bottom} L ${points.map((p) => `${p.x} ${p.y}`).join(' L ')} L ${points[points.length - 1].x} ${chart.h - chart.bottom} Z`
    : '';

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2, duration: 0.6 }}
      className="glass p-6 md:p-7 lg:sticky lg:top-6"
    >
      <div className="flex items-end justify-between mb-3 flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink-900 tracking-tight">Pass-rate trend</h2>
          <p className="text-sm text-ink-500 mt-0.5">
            Per-run pass rate · last {values.length} measured run{values.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className={`text-3xl font-extrabold tabular-nums ${TONE_TEXT[tone]}`}>
            <AnimatedNumber value={last} suffix="%" />
          </div>
          {values.length > 1 && !isFlat && (
            <div className={`text-xs font-semibold pb-1 ${TONE_TEXT[tone]}`}>
              {delta >= 0 ? '↑' : '↓'} {Math.abs(delta)} pp
            </div>
          )}
          {isFlat && values.length > 1 && (
            <div className="text-xs font-semibold pb-1 text-ink-500">stable</div>
          )}
        </div>
      </div>

      <div className="h-44 -mx-3">
        <svg
          viewBox={`0 0 ${chart.w} ${chart.h}`}
          className="h-full w-full overflow-visible"
          role="img"
          aria-label={`Pass-rate trend from ${first}% to ${last}%`}
          preserveAspectRatio="none"
        >
          <path d={areaPath} fill={hex} opacity="0.12" />
          <polyline points={linePoints} fill="none" stroke={hex} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          {points.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r="4" fill="#fff" stroke={hex} strokeWidth="2" />
              <title>{`Run ${i + 1}: ${p.value}% pass rate`}</title>
            </g>
          ))}
        </svg>
      </div>
      {isFlat && (
        <div className="text-2xs text-ink-500 mt-2 italic">
          {values.length} consecutive run{values.length === 1 ? '' : 's'} at {last}%.
        </div>
      )}
    </motion.section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GlassRunsTable — glass surface with row hover lift, inline pass-rate ring,
// and a colored status pill.
// ─────────────────────────────────────────────────────────────────────────────
function GlassRunsTable({ runs, onRowClick, onAll }) {
  if (!runs || runs.length === 0) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25, duration: 0.6 }}
      className="glass p-6 md:p-7"
    >
      <div className="flex items-end justify-between mb-5 flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold text-ink-900 tracking-tight">Recent runs</h2>
          <p className="text-sm text-ink-500 mt-0.5">The last {Math.min(runs.length, 6)} runs across this project</p>
        </div>
        <button
          type="button"
          onClick={onAll}
          className="text-xs font-semibold text-ink-600 hover:text-ink-900 inline-flex items-center gap-0.5"
        >
          All runs <ArrowUpRight className="w-3 h-3" />
        </button>
      </div>

      <div className="overflow-x-auto -mx-2">
        <table className="w-full">
          <thead>
            <tr className="text-2xs uppercase tracking-[0.14em] font-bold text-ink-500">
              <th className="text-left  px-2 pb-3">Status</th>
              <th className="text-left  px-2 pb-3">Started</th>
              <th className="text-left  px-2 pb-3 hidden md:table-cell">Scenarios</th>
              <th className="text-right px-2 pb-3">Pass</th>
              <th className="text-right px-2 pb-3">Fail</th>
              <th className="text-right px-2 pb-3 hidden sm:table-cell">Blocked</th>
              <th className="text-right px-2 pb-3">Pass rate</th>
              <th className="w-6"></th>
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, 6).map((r, i) => (
              <RunRow key={r.id} run={r} index={i} onClick={() => onRowClick(r.id)} />
            ))}
          </tbody>
        </table>
      </div>
    </motion.section>
  );
}

function RunRow({ run, index, onClick }) {
  const denom = (run.passed || 0) + (run.failed || 0) + (run.blocked || 0);
  // denom === 0 means the run was cancelled or every case was test.skip()'d —
  // there's no measurement to display. Render "—" instead of a fake 0%.
  const measured = denom > 0;
  const rate = measured ? Math.round((run.passed / denom) * 100) : null;
  const rateTone = !measured ? 'ink' : rate >= 80 ? 'success' : rate >= 50 ? 'warn' : 'danger';
  const statusTone = {
    completed: 'success', failed: 'danger', cancelled: 'ink', running: 'info',
  }[run.status] || 'info';
  const statusBg = {
    success: 'bg-success-100/80 text-success-700 border-success-200/60',
    danger:  'bg-danger-100/80  text-danger-700  border-danger-200/60',
    ink:     'bg-ink-100/80     text-ink-600     border-ink-200/60',
    info:    'bg-info-100/80    text-info-700    border-info-200/60',
  }[statusTone];
  const scenarios = Array.isArray(run.scenarios) ? run.scenarios : [];
  // Distinctive PRIMARY label — every row has a unique start time, so the
  // timestamp is the natural per-row identifier. The first-scenario-name
  // pattern (previous version) made every row look identical when a project's
  // scenarios share a naming prefix (e.g. "Verify Unique User…", "Verify
  // Secure Authentication…"). DESCRIPTIVE subtitle communicates what the run
  // actually was: how many scenarios, how many cases, which sprint.
  const startedLabel = new Date(run.startedAt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const descriptorBits = [];
  if (scenarios.length > 0) descriptorBits.push(`${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}`);
  if (run.testCount > 0) descriptorBits.push(`${run.testCount} test case${run.testCount === 1 ? '' : 's'}`);
  if (run.sprintName) descriptorBits.push(run.sprintName);
  const descriptor = descriptorBits.join(' · ');
  // Full scenario list as a tooltip so power-users who want to see exactly
  // what ran can hover over the row without losing the at-a-glance summary.
  const scenarioListTitle = scenarios.length
    ? scenarios.map((s) => `• ${s.name}`).join('\n')
    : 'No scenarios attached to this run.';

  return (
    <motion.tr
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.35 + index * 0.05, duration: 0.45 }}
      onClick={onClick}
      className="cursor-pointer group transition-colors hover:bg-white/45"
    >
      <td className="px-2 py-3">
        <span className={`inline-flex items-center text-2xs uppercase tracking-wider font-bold px-2 h-6 rounded-pill border backdrop-blur-sm ${statusBg}`}>
          {run.status}
        </span>
      </td>
      <td className="px-2 py-3" title={scenarioListTitle}>
        <div className="text-sm font-semibold text-ink-900 tabular-nums">
          {startedLabel}
        </div>
        <div className="text-2xs text-ink-500 mt-0.5 tabular-nums truncate max-w-[22ch] md:max-w-[36ch]">
          {descriptor || 'Untitled run'}
        </div>
      </td>
      <td className="px-2 py-3 hidden md:table-cell text-sm text-ink-700 tabular-nums">
        {scenarios.length || (run.testCount ?? '—')}
      </td>
      <td className="px-2 py-3 text-right text-sm font-semibold text-success-700 tabular-nums">{run.passed ?? 0}</td>
      <td className="px-2 py-3 text-right text-sm font-semibold text-danger-700 tabular-nums">{run.failed ?? 0}</td>
      <td className="px-2 py-3 text-right text-sm font-semibold text-warn-700 tabular-nums hidden sm:table-cell">{run.blocked ?? 0}</td>
      <td className="px-2 py-3 text-right">
        {measured ? (
          <div className="inline-flex items-center gap-2 justify-end">
            <span className={`text-base font-bold tabular-nums ${TONE_TEXT[rateTone]}`}>{rate}%</span>
          </div>
        ) : (
          <span className="text-base font-bold text-ink-400 tabular-nums" title="No measurement — run was cancelled or every case was skipped">
            —
          </span>
        )}
      </td>
      <td className="px-2 py-3 text-right">
        <ChevronRight className="w-4 h-4 text-ink-300 group-hover:text-ink-700 transition-colors inline-block" />
      </td>
    </motion.tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// VerdictHealthCard — Phase H M5 disagreement-rate dashboard.
//
// Two-series comparison (legacy vs mechanical_v1) over a rolling 7-day
// window. Hides itself entirely when there's no mechanical_v1 data yet —
// most projects' first view will not see this card at all, by design.
// Once mechanical_v1 runs accumulate, the card surfaces the observable
// proof that "the report has stopped lying": rescued false-fails,
// surfaced uncheckables, caught over-claimed passes.
//
// Per CLAUDE.md: never read execution counts directly off Run.passed — we
// pull from the verdict endpoint which aggregates RunResult.flipDirection.
// ─────────────────────────────────────────────────────────────────────────────
function VerdictHealthCard({ data }) {
  if (!data || !Array.isArray(data.verdictVersions)) return null;
  const mech = data.verdictVersions.find((v) => v.verdictVersion === 'mechanical_v1');
  // Hide the card entirely until mechanical_v1 produces at least one row —
  // showing it empty would suggest there's something wrong, when in fact
  // the mode just hasn't been enabled yet.
  if (!mech || mech.totalRuns === 0) return null;

  const legacy = data.verdictVersions.find((v) => v.verdictVersion === 'legacy');

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25, duration: 0.5 }}
      className="glass p-6 md:p-7"
    >
      <header className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-accent-50/60 ring-1 ring-accent-200/60 p-2">
            <Scale className="w-5 h-5 text-accent-600" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-ink-900 tracking-tight">Verdict integrity</h2>
            <p className="text-sm text-ink-500 mt-0.5">
              Rolling {data.windowDays}-day comparison · agent claim vs mechanical computation
            </p>
          </div>
        </div>
        {data.headline && (
          <div className="text-sm font-medium text-accent-700 max-w-md text-right">
            {data.headline}
          </div>
        )}
      </header>

      <div className="grid md:grid-cols-2 gap-4">
        <VerdictColumn
          version="legacy"
          label="Legacy ladder"
          subtitle="agent-claimed status drives verdict"
          bucket={legacy}
        />
        <VerdictColumn
          version="mechanical_v1"
          label="Mechanical verdict"
          subtitle="backend computes from assertion outcomes"
          bucket={mech}
          highlight
        />
      </div>
    </motion.section>
  );
}

function VerdictColumn({ label, subtitle, bucket, highlight }) {
  const empty = !bucket || bucket.totalRuns === 0;
  return (
    <div className={`rounded-2xl p-5 ring-1 ${highlight
      ? 'bg-gradient-to-br from-accent-50/60 to-info-50/40 ring-accent-200/60'
      : 'bg-white/40 ring-ink-200/50'}`}>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-base font-semibold text-ink-900">{label}</div>
          <div className="text-xs text-ink-500 mt-0.5">{subtitle}</div>
        </div>
        {!empty && (
          <div className="text-right">
            <div className="text-3xl font-extrabold tabular-nums text-ink-900">
              <AnimatedNumber value={bucket.disagreementRate} suffix="%" decimals={1} />
            </div>
            <div className="text-[11px] uppercase tracking-wide text-ink-500 font-medium">
              disagreement rate
            </div>
          </div>
        )}
      </div>
      {empty ? (
        <div className="text-sm text-ink-500 italic py-4">
          No runs in this window.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 text-sm mb-3">
            <Metric label="Total runs"   value={bucket.totalRuns}   tone="ink"  />
            <Metric label="Agreed"       value={bucket.agreedCount} tone="info" />
          </div>
          {bucket.disagreedCount > 0 && (
            <div className="border-t border-ink-200/40 pt-3 mt-1 space-y-1.5">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-ink-500 font-medium">
                <ArrowLeftRight className="w-3 h-3" />
                <span>Disagreements ({bucket.disagreedCount})</span>
              </div>
              {bucket.rescuedFalseFails > 0 && (
                <FlipRow tone="success" label="Rescued false-fails" value={bucket.rescuedFalseFails}
                  hint="agent said fail; mechanical said pass — caught lying-as-fail" />
              )}
              {bucket.surfacedUncheckables > 0 && (
                <FlipRow tone="warn" label="Surfaced uncheckables" value={bucket.surfacedUncheckables}
                  hint="agent reported fail; mechanical found assertion was uncheckable (page not reached or snapshot unavailable)" />
              )}
              {bucket.caughtOverclaimedPasses > 0 && (
                <FlipRow tone="danger" label="Caught over-claimed passes" value={bucket.caughtOverclaimedPasses}
                  hint="agent said pass; mechanical said fail — caught lying-as-pass" />
              )}
              {bucket.suspiciousPasses > 0 && (
                <FlipRow tone="warn" label="Suspicious passes" value={bucket.suspiciousPasses}
                  hint="agent said pass on assertions we couldn't even verify" />
              )}
              {bucket.otherFlips > 0 && (
                <FlipRow tone="info" label="Other transitions"
                  value={bucket.otherFlips}
                  hint="disagreements that don't fit the main flip categories (internal diagnostic)" />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value, tone = 'ink' }) {
  const toneClass = tone === 'info' ? 'text-info-700' : 'text-ink-900';
  return (
    <div className="rounded-lg bg-white/50 ring-1 ring-ink-200/50 px-3 py-2">
      <div className={`text-lg font-extrabold tabular-nums ${toneClass}`}>
        <AnimatedNumber value={value || 0} />
      </div>
      <div className="text-[11px] uppercase tracking-wide text-ink-500 font-medium">{label}</div>
    </div>
  );
}

function FlipRow({ tone, label, value, hint }) {
  const dotClass = {
    success: 'bg-success-500',
    danger:  'bg-danger-500',
    warn:    'bg-warn-500',
    info:    'bg-info-500',
  }[tone] || 'bg-ink-400';
  return (
    <div className="flex items-start gap-2.5 group" title={hint}>
      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full ${dotClass} flex-shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-ink-900 truncate">{label}</span>
          <span className="text-sm font-bold tabular-nums text-ink-900">
            <AnimatedNumber value={value} />
          </span>
        </div>
        <div className="text-[11px] text-ink-500 leading-snug">{hint}</div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Overview — the page
// ─────────────────────────────────────────────────────────────────────────────
export default function Overview() {
  const navigate = useNavigate();
  const { current, currentSprint, currentGenerationId } = useProject();
  const toast = useToast();
  const { latestSummary, subscribe } = useRunStream();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // Phase H M5 — separate fetch so the verdict-integrity card can hide
  // itself silently when there's no data, without bloating the main
  // dashboard payload. Empty initial state = card not rendered.
  const [verdictData, setVerdictData] = useState(null);

  // Isolation guard — every fetch is tagged with a monotonic sequence id and
  // the project it was issued for. A newer load (project switch / refresh /
  // WS reload) bumps the sequence, so a stale in-flight response can never
  // paint one project's numbers onto another's dashboard (the cross-project
  // "collision" the operator hit: Orange HRM showing SauseDemo's results).
  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    if (!current) { setData(null); setVerdictData(null); setLoading(false); return; }
    const projectId = current.id;
    const reqId = ++reqSeq.current;
    setLoading(true);
    // Versioning — scope the dashboard to the active generation.
    const genQs = currentGenerationId ? `?generationId=${encodeURIComponent(currentGenerationId)}` : '';
    try {
      const res = await api.get(`/dashboard/${projectId}${genQs}`);
      if (reqId !== reqSeq.current) return;   // a newer load superseded this one — drop it
      setData(res);
    } catch (err) {
      if (reqId === reqSeq.current) toast.error(err.message);
    } finally {
      if (reqId === reqSeq.current) setLoading(false);
    }
    // Verdict-integrity fetch is independent — silent failure is OK
    // because the card just doesn't render rather than showing an error.
    try {
      const v = await api.get(`/dashboard/${projectId}/verdict-disagreement?days=7`);
      if (reqId === reqSeq.current) setVerdictData(v);
    } catch (_) { /* swallow — card stays hidden */ }
  }, [current, currentGenerationId, toast]);

  // Drop the previous project's data the instant the active project changes,
  // so its numbers can't linger on the new project's dashboard during the
  // refetch window. The load effect below refills it for the new project.
  useEffect(() => {
    setData(null);
    setVerdictData(null);
    setLoading(true);
  }, [current?.id]);

  useEffect(() => { load(); }, [load]);
  // Keep a stable ref to the latest load so the latestSummary effect always
  // calls the current-project version, even if latestSummary hasn't changed
  // since the last project switch (same object reference across the switch).
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    if (latestSummary) loadRef.current();
  }, [latestSummary]);

  // Real-time Overview — subscribe to per-case WS events so Module health,
  // Recent Runs counts, and the Pass-rate trend update as the conductor
  // finishes each case, not just at run.complete. The fetch is debounced so
  // a flurry of result events during a fast run doesn't hammer /dashboard.
  // Project-scoped: events from a different project (concurrent run by
  // another operator) must not trigger this project's reload.
  useEffect(() => {
    if (!current?.id) return;
    let debounceId = null;
    const scheduleReload = () => {
      if (debounceId) clearTimeout(debounceId);
      debounceId = setTimeout(() => { debounceId = null; load(); }, 250);
    };
    const unsub = subscribe((msg) => {
      if (msg.projectId && msg.projectId !== current.id) return;
      if (msg.type === 'result' || msg.type === 'run.counters' || msg.type === 'run.complete' || msg.type === 'run.started') {
        scheduleReload();
      }
    });
    return () => {
      if (debounceId) clearTimeout(debounceId);
      unsub();
    };
  }, [subscribe, current?.id, load]);

  // Trend (pass-rate across recent runs) — same logic as old Overview.
  const trendValues = useMemo(() => {
    const runs = data?.recentRuns || [];
    return runs
      .slice()
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
      .map((r) => {
        const denom = (r.passed || 0) + (r.failed || 0) + (r.blocked || 0);
        return denom > 0 ? Math.round((r.passed / denom) * 100) : null;
      })
      .filter((v) => v !== null);
  }, [data]);

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <EmptyState
          illustration="overview"
          title="No project yet"
          message="Create or activate a project to see real metrics here."
          action={<Button size="md" onClick={() => navigate('/project-setup')}>Create project</Button>}
        />
      </div>
    );
  }

  const stats = data?.stats;

  return (
    // MotionConfig with reducedMotion="user" tells framer-motion to honour the
    // user's prefers-reduced-motion at the OS level: transforms (y/scale)
    // snap to target, opacity transitions stay. We only need this at the page
    // root because all motion children inherit from the nearest MotionConfig.
    <MotionConfig reducedMotion="user">
    <div className="flex flex-col h-full overflow-hidden">
      <main
        className="flex-1 overflow-y-auto relative"
        style={{ scrollbarGutter: 'stable' }}
      >
        {/* Aurora layer: a sticky wrapper sized to the dynamic viewport
            (dvh, not vh — vh varies by browser scrollbar handling, dvh is
            consistent in Chromium / WebKit / Firefox). The negative
            margin-bottom collapses its flow contribution so subsequent
            siblings start at the top of main, sitting visually on top of
            the aurora via z-index. */}
        <div
          className="sticky top-0 overflow-hidden pointer-events-none"
          style={{ height: '100dvh', marginBottom: '-100dvh', zIndex: 0 }}
          aria-hidden="true"
        >
          <AuroraBackground />
        </div>

        <div className="relative z-10 max-w-7xl mx-auto px-page py-5 space-y-5">
          {loading ? (
            <OverviewSkeleton />
          ) : (
            <>
              <HeroVerdict
                stats={stats}
                trendValues={trendValues}
                onReRun={() => navigate('/run-suite')}
              />

              {/* KPI rail — 5 glass tiles */}
              <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                <GlassKPI
                  icon={CheckCircle2}
                  label="Passed"
                  tone="success"
                  value={stats?.passed ?? 0}
                  sublabel={stats?.testCases ? `of ${stats.testCases} cases` : ''}
                  ringPct={stats?.testCases ? Math.round((stats.passed / stats.testCases) * 100) : 0}
                  onClick={() => navigate('/test-cases?status=pass')}
                />
                <GlassKPI
                  icon={XCircle}
                  label="Failed"
                  tone="danger"
                  value={stats?.failed ?? 0}
                  sublabel={stats?.testCases ? `of ${stats.testCases} cases` : ''}
                  ringPct={stats?.testCases ? Math.round(((stats.failed ?? 0) / stats.testCases) * 100) : 0}
                  onClick={() => navigate('/test-cases?status=fail')}
                />
                <GlassKPI
                  icon={ShieldAlert}
                  label="Blocked"
                  tone="warn"
                  value={stats?.blocked ?? 0}
                  sublabel="distinct cases"
                  ringPct={stats?.testCases ? Math.round(((stats.blocked ?? 0) / stats.testCases) * 100) : 0}
                  onClick={() => navigate('/blocked-items')}
                />
                <GlassKPI
                  icon={Target}
                  label="Coverage"
                  tone="info"
                  value={stats?.coveragePercent ?? 0}
                  suffix="%"
                  sublabel={
                    stats?.executed != null && stats?.testCases
                      ? `${stats.executed} of ${stats.testCases} executed`
                      : 'awaiting first run'
                  }
                  ringPct={stats?.coveragePercent ?? 0}
                  onClick={stats?.latestRunId ? () => navigate(`/reports?runId=${stats.latestRunId}`) : undefined}
                />
                <GlassKPI
                  icon={GitPullRequest}
                  label="Generated specs"
                  tone="accent"
                  value={stats?.pendingPRs ?? 0}
                  sublabel="open in Output Files"
                  ringPct={undefined}
                  onClick={() => navigate('/output-files')}
                />
              </section>

              {/* Two-column: module health + trend.
                  Use lg (1024px), not xl (1280px). Most laptop browsers sit
                  right around 1280px after the sidebar, and a ±10px chrome
                  diff between Edge/Chrome would flip the layout — one shows
                  2-col, the other stacks. lg gives a much wider safety band.
                  `items-start` so a tall Module health (20+ modules) doesn't
                  stretch the TrendChart card into a blank rectangle. The
                  chart pins itself via lg:sticky inside its own column. */}
              <section className="grid lg:grid-cols-[1.5fr_1fr] gap-5 items-start">
                <ModuleHealthRadial
                  modules={data?.modules}
                  onModuleClick={(m) => navigate(`/test-cases?module=${encodeURIComponent(m)}`)}
                />
                <TrendChart values={trendValues} />
              </section>

              <GlassRunsTable
                runs={data?.recentRuns || []}
                onRowClick={(id) => navigate(`/reports?runId=${id}`)}
                onAll={() => navigate('/reports')}
              />

              {/* Phase H M5 — Verdict integrity card. Renders only when
                  mechanical_v1 has produced at least one RunResult in the
                  rolling 7-day window. Until then the card stays hidden so
                  the Overview isn't cluttered with empty-state filler. */}
              <VerdictHealthCard data={verdictData} />

              {stats?.testCases === 0 && (
                <EmptyState
                  icon={ShieldCheck}
                  title="Nothing to report yet"
                  message="Pull requirements, generate test cases, and run them to see real metrics here."
                  action={<Button size="md" onClick={() => navigate('/run-suite')}>Get started</Button>}
                />
              )}
            </>
          )}
        </div>
      </main>
    </div>
    </MotionConfig>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="glass p-10 h-[280px] flex items-center gap-12">
        <Skeleton className="h-44 w-44" rounded="pill" />
        <div className="flex-1 space-y-4">
          <Skeleton className="h-3 w-40" rounded="pill" />
          <Skeleton className="h-16 w-48" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {[0,1,2,3,4].map((i) => (
          <div key={i} className="glass p-5 space-y-3">
            <Skeleton className="h-3 w-20" rounded="pill" />
            <Skeleton className="h-10 w-16" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-6">
        <div className="glass p-6 h-72">
          <Skeleton className="h-4 w-40 mb-5" />
          <div className="grid grid-cols-3 lg:grid-cols-4 gap-4">
            {[0,1,2,3,4,5,6,7].map((i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        </div>
        <div className="glass p-6 h-72 space-y-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-44 w-full" />
        </div>
      </div>
      <div className="glass p-6 h-72">
        <Skeleton className="h-4 w-40 mb-5" />
        {[0,1,2,3].map((i) => (
          <Skeleton key={i} className="h-10 w-full mb-2" />
        ))}
      </div>
    </div>
  );
}
