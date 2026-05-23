import React from 'react';
import { Loader2 } from 'lucide-react';

const variants = {
  primary:
    'bg-ink-900 text-white border border-ink-900 ' +
    'hover:bg-ink-800 hover:border-ink-800 ' +
    'active:bg-ink-900 ' +
    'disabled:bg-ink-200 disabled:text-ink-400 disabled:border-ink-200 disabled:cursor-not-allowed',
  secondary:
    'bg-white text-ink-800 border border-ink-200 shadow-card ' +
    'hover:bg-ink-50 hover:border-ink-300 hover:shadow-card-hover ' +
    'disabled:opacity-60 disabled:cursor-not-allowed',
  danger:
    'bg-danger-600 text-white border border-danger-600 ' +
    'hover:bg-danger-700 hover:border-danger-700 ' +
    'disabled:bg-danger-100 disabled:text-danger-500 disabled:border-danger-100',
  ghost:
    'bg-transparent text-ink-700 border border-transparent ' +
    'hover:bg-ink-100 hover:text-ink-900 ' +
    'disabled:opacity-50 disabled:cursor-not-allowed',
  outline:
    'bg-white text-ink-800 border border-ink-300 ' +
    'hover:bg-ink-50 hover:border-ink-400 ' +
    'disabled:opacity-50 disabled:cursor-not-allowed',
};

const sizes = {
  sm: 'h-8 px-3 text-xs font-medium gap-1.5 rounded-md',
  md: 'h-10 px-4 text-sm font-semibold gap-2 rounded-btn',
  lg: 'h-11 px-5 text-sm font-semibold gap-2 rounded-btn',
};

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  type = 'button',
  className = '',
  children,
  ...props
}) {
  const isInactive = loading || disabled;
  return (
    <button
      type={type}
      {...props}
      disabled={isInactive}
      // aria-busy announces the loading state to screen readers so users hear
      // "busy" instead of silently waiting for the click to finish.
      aria-busy={loading || undefined}
      // aria-disabled is redundant with disabled for click-blocking but adds
      // semantic clarity (some screen readers announce both differently).
      aria-disabled={isInactive || undefined}
      className={`inline-flex items-center justify-center whitespace-nowrap transition-all duration-150 ease-out-soft focus-visible:shadow-ring ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
