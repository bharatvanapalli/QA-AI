import React from 'react';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Circle,
} from 'lucide-react';

/**
 * status: 'unconfigured' | 'validating' | 'valid' | 'invalid' | 'saved' | 'idle'
 */
const META = {
  unconfigured: {
    label: 'Not Configured',
    icon: AlertTriangle,
    className: 'bg-warn-50 text-warn-700 border-warn-100',
    dotClass: 'bg-warn-500',
  },
  validating: {
    label: 'Validating…',
    icon: Loader2,
    className: 'bg-info-50 text-info-700 border-info-100',
    dotClass: 'bg-info-500',
    spin: true,
  },
  valid: {
    label: 'Connected',
    icon: CheckCircle2,
    className: 'bg-success-50 text-success-700 border-success-100',
    dotClass: 'bg-success-500',
  },
  saved: {
    label: 'Saved',
    icon: CheckCircle2,
    className: 'bg-success-50 text-success-700 border-success-100',
    dotClass: 'bg-success-500',
  },
  invalid: {
    label: 'Failed',
    icon: XCircle,
    className: 'bg-danger-50 text-danger-700 border-danger-100',
    dotClass: 'bg-danger-500',
  },
  idle: {
    label: 'Idle',
    icon: Circle,
    className: 'bg-ink-100 text-ink-600 border-ink-200',
    dotClass: 'bg-ink-400',
  },
};

export default function StatusBadge({ status = 'idle', label, className = '', dot = false }) {
  const m = META[status] || META.idle;
  const Icon = m.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill text-xs font-medium border ${m.className} ${className}`}
    >
      {dot ? (
        <span className={`w-1.5 h-1.5 rounded-full ${m.dotClass} ${m.spin ? 'animate-pulse' : ''}`} />
      ) : (
        <Icon className={`w-3 h-3 ${m.spin ? 'animate-spin' : ''}`} aria-hidden />
      )}
      {label || m.label}
    </span>
  );
}
