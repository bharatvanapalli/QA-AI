import React, { forwardRef, useId } from 'react';

const Input = forwardRef(function Input(
  { label, hint, error, className = '', id, optional, ...props },
  ref
) {
  // Stable, unique id even when no label is provided (or label is blank) —
  // protects against duplicate ids when a form has multiple Input rows.
  const reactId = useId();
  const labelSlug = label ? label.replace(/\W+/g, '-').toLowerCase() : '';
  const inputId = id || `inp-${labelSlug || reactId}`;
  const describedById = error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-xs font-semibold text-ink-700 flex items-center gap-2">
          {label}
          {optional && (
            <span className="text-2xs uppercase tracking-wider font-medium text-ink-400">
              optional
            </span>
          )}
        </label>
      )}
      <input
        id={inputId}
        ref={ref}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedById}
        {...props}
        className={`h-10 px-3.5 rounded-md border bg-white text-sm text-ink-900 placeholder:text-ink-400
          transition-all duration-150 ease-out-soft
          focus:outline-none focus:border-ink-900 focus:shadow-ring
          ${error ? 'border-danger-400 focus:border-danger-500 focus:shadow-ring-rose' : 'border-ink-200 hover:border-ink-300'}
          ${className}`}
      />
      {error ? (
        <span id={`${inputId}-err`} className="text-xs text-danger-600">{error}</span>
      ) : hint ? (
        <span id={`${inputId}-hint`} className="text-xs text-ink-500">{hint}</span>
      ) : null}
    </div>
  );
});

export default Input;
