/**
 * Single source of truth for status / priority / category / type meta.
 *
 * Use these in place of per-page hard-coded maps. When marketing renames a
 * label or design tweaks a colour, change one entry here instead of hunting
 * across TestCases.jsx, Reports.jsx, Overview.jsx, BlockedItems.jsx,
 * Governance.jsx, etc.
 *
 * Colour classes use the design tokens defined in tailwind.config.js
 * (success/danger/warn/info/accent + ink). Lucide icon refs are passed
 * through directly so callers can render <Meta.icon className="..." />.
 */

import {
  CheckCircle2, XCircle, AlertCircle, AlertOctagon, AlertTriangle, Clock,
  CircleCheck, Network, Hash, Inbox, Workflow, Circle, Loader2, StopCircle,
} from 'lucide-react';

// ── Test-result / test-case status ──────────────────────────────
// Used by Reports (per-test row), TestCases (case status pill), Overview
// (KPI tiles), Theater (per-phase summary), BlockedItems (count rail).
export const STATUS_META = {
  pass: {
    label: 'Pass',
    icon: CheckCircle2,
    dot: 'bg-success-500',
    text: 'text-success-700',
    bg: 'bg-success-50',
    border: 'border-success-200',
    cls: 'bg-success-50 text-success-700 border-success-200',
  },
  fail: {
    label: 'Fail',
    icon: XCircle,
    dot: 'bg-danger-500',
    text: 'text-danger-700',
    bg: 'bg-danger-50',
    border: 'border-danger-200',
    cls: 'bg-danger-50 text-danger-700 border-danger-200',
  },
  blocked: {
    label: 'Blocked',
    icon: AlertCircle,
    dot: 'bg-warn-500',
    text: 'text-warn-700',
    bg: 'bg-warn-50',
    border: 'border-warn-200',
    cls: 'bg-warn-50 text-warn-700 border-warn-200',
  },
  running: {
    label: 'Running',
    icon: Clock,
    dot: 'bg-info-500',
    text: 'text-info-700',
    bg: 'bg-info-50',
    border: 'border-info-200',
    cls: 'bg-info-50 text-info-700 border-info-200',
  },
  approved: {
    label: 'Approved',
    icon: CheckCircle2,
    dot: 'bg-success-500',
    text: 'text-success-700',
    bg: 'bg-success-50',
    border: 'border-success-200',
    cls: 'bg-success-50 text-success-700 border-success-200',
  },
  rejected: {
    label: 'Rejected',
    icon: XCircle,
    dot: 'bg-ink-400',
    text: 'text-ink-600',
    bg: 'bg-ink-100',
    border: 'border-ink-200',
    cls: 'bg-ink-100 text-ink-600 border-ink-200',
  },
  pending: {
    label: 'Pending',
    icon: Clock,
    dot: 'bg-ink-400',
    text: 'text-ink-600',
    bg: 'bg-ink-100',
    border: 'border-ink-200',
    cls: 'bg-ink-100 text-ink-600 border-ink-200',
  },
};

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.pending;
}

// ── Priority ────────────────────────────────────────────────────
export const PRIORITY_META = {
  P0: { label: 'P0', cls: 'bg-danger-50 text-danger-700 border-danger-200', icon: AlertOctagon,  blurb: 'blocker' },
  P1: { label: 'P1', cls: 'bg-warn-50 text-warn-700 border-warn-200',       icon: AlertTriangle, blurb: 'high' },
  P2: { label: 'P2', cls: 'bg-info-50 text-info-700 border-info-100',       icon: AlertCircle,   blurb: 'normal' },
  P3: { label: 'P3', cls: 'bg-ink-100 text-ink-600 border-ink-200',         icon: CircleCheck,   blurb: 'nice-to-have' },
};

export function priorityMeta(p) {
  return PRIORITY_META[p] || PRIORITY_META.P3;
}

// ── Scenario category ───────────────────────────────────────────
export const CATEGORY_META = {
  positive: { label: 'Positive', cls: 'bg-success-50 text-success-700', icon: CircleCheck },
  negative: { label: 'Negative', cls: 'bg-danger-50 text-danger-700',   icon: AlertOctagon },
  edge:     { label: 'Edge',     cls: 'bg-accent-50 text-accent-700',   icon: Network },
  boundary: { label: 'Boundary', cls: 'bg-warn-50 text-warn-700',       icon: Hash },
  empty:    { label: 'Empty',    cls: 'bg-ink-100 text-ink-700',        icon: Inbox },
  e2e:      { label: 'E2E',      cls: 'bg-info-50 text-info-700',       icon: Workflow },
};

export function categoryMeta(c) {
  return CATEGORY_META[c] || CATEGORY_META.positive;
}

// ── Test-case type ──────────────────────────────────────────────
// Lighter than CATEGORY — used as a small inline tag (no icon, just bg+text).
export const TYPE_META = {
  smoke:       { label: 'Smoke',       cls: 'bg-info-50    text-info-700' },
  regression:  { label: 'Regression',  cls: 'bg-accent-50  text-accent-700' },
  functional:  { label: 'Functional',  cls: 'bg-success-50 text-success-700' },
  security:    { label: 'Security',    cls: 'bg-danger-50  text-danger-700' },
  integration: { label: 'Integration', cls: 'bg-warn-50    text-warn-700' },
  boundary:    { label: 'Boundary',    cls: 'bg-ink-100    text-ink-700' },
};

export function typeMeta(t) {
  return TYPE_META[t] || { label: t || '—', cls: 'bg-ink-100 text-ink-700' };
}

// ── Agent phase status (Theater timeline) ───────────────────────
// The Live Pipeline timeline maps each agent phase to one of these visual
// states. `idle` is the pre-start state (the dot before the phase has
// started); `running` is in-flight; the rest are terminal.
//
// Used by [src/pages/Theater.jsx](src/pages/Theater.jsx) PhaseTimeline.
export const PHASE_STATUS_META = {
  idle: {
    label: 'Idle',
    icon: Circle,
    dot: 'bg-ink-300',
    text: 'text-ink-500',
    bg: 'bg-ink-50',
    border: 'border-ink-200',
    cls: 'bg-ink-50 text-ink-500 border-ink-200',
    ring: 'ring-ink-200',
  },
  running: {
    label: 'Running',
    icon: Loader2,
    dot: 'bg-info-500',
    text: 'text-info-700',
    bg: 'bg-info-50',
    border: 'border-info-300',
    cls: 'bg-info-50 text-info-700 border-info-300',
    ring: 'ring-info-400',
  },
  complete: {
    label: 'Done',
    icon: CheckCircle2,
    dot: 'bg-success-500',
    text: 'text-success-700',
    bg: 'bg-success-50',
    border: 'border-success-200',
    cls: 'bg-success-50 text-success-700 border-success-200',
    ring: 'ring-success-300',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    dot: 'bg-danger-500',
    text: 'text-danger-700',
    bg: 'bg-danger-50',
    border: 'border-danger-200',
    cls: 'bg-danger-50 text-danger-700 border-danger-200',
    ring: 'ring-danger-300',
  },
  cancelled: {
    label: 'Cancelled',
    icon: StopCircle,
    dot: 'bg-warn-500',
    text: 'text-warn-700',
    bg: 'bg-warn-50',
    border: 'border-warn-200',
    cls: 'bg-warn-50 text-warn-700 border-warn-200',
    ring: 'ring-warn-300',
  },
};

export function phaseStatusMeta(s) {
  return PHASE_STATUS_META[s] || PHASE_STATUS_META.idle;
}
