import React from 'react';

/**
 * Shimmer placeholder used while data loads. Uses the `.skeleton` class from
 * index.css (with a `prefers-reduced-motion` fallback that turns the sweep
 * off and just shows a muted block) so we don't ship a motion-sensitivity
 * accessibility violation.
 *
 * Always render a placeholder whose height matches the final element to
 * avoid layout shift — pass explicit `h-*` / `w-*` Tailwind classes from
 * the caller; defaults give a one-line text-sized block.
 *
 * Props:
 *   className   extra Tailwind for sizing / margins
 *   rounded     'sm' | 'md' | 'lg' | 'full' — defaults to 'md'
 *   as          render tag, defaults to 'div'
 *   ariaLabel   optional explicit announce text; defaults to a generic
 *               "Loading" so the bare placeholder doesn't read as silence.
 */
export default function Skeleton({
  className = '',
  rounded = 'md',
  as: Tag = 'div',
  ariaLabel = 'Loading',
  ...props
}) {
  const round = {
    sm: 'rounded-sm',
    md: 'rounded-md',
    lg: 'rounded-lg',
    card: 'rounded-card',
    pill: 'rounded-pill',
    full: 'rounded-full',
  }[rounded] || 'rounded-md';

  return (
    <Tag
      {...props}
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      className={`skeleton ${round} ${className}`}
    />
  );
}

/**
 * Convenience composite for a "card-shaped" skeleton with a title + subtitle
 * + a body block — the most common loading-card shape on this app.
 */
export function CardSkeleton({ className = '' }) {
  return (
    <div className={`rounded-card border border-ink-200 bg-white shadow-card p-5 space-y-3 ${className}`} aria-hidden="true">
      <Skeleton className="h-3 w-24" rounded="pill" />
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-5/6" />
    </div>
  );
}
