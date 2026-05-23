import React, { useState, forwardRef, useId } from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';

const SecretInput = forwardRef(function SecretInput(
  { label, hint, error, value, onChange, placeholderMask, className = '', id, ...props },
  ref
) {
  const [shown, setShown] = useState(false);
  const reactId = useId();
  const labelSlug = label ? label.replace(/\W+/g, '-').toLowerCase() : '';
  const inputId = id || `secret-${labelSlug || reactId}`;
  const describedById = error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-xs font-semibold text-ink-700 flex items-center gap-1.5">
          <Lock className="w-3 h-3 text-ink-400" aria-hidden="true" />
          {label}
        </label>
      )}
      <div className="relative">
        <input
          id={inputId}
          ref={ref}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          placeholder={placeholderMask || ''}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedById}
          {...props}
          className={`h-10 w-full pl-3.5 pr-10 rounded-md border bg-white text-sm text-ink-900 placeholder:text-ink-400 font-mono
            transition-all duration-150 ease-out-soft
            focus:outline-none focus:border-ink-900 focus:shadow-ring
            ${error ? 'border-danger-400 focus:border-danger-500 focus:shadow-ring-rose' : 'border-ink-200 hover:border-ink-300'}
            ${className}`}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          tabIndex={-1}
          aria-label={shown ? 'Hide value' : 'Show value'}
          aria-pressed={shown}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-ink-400 hover:text-ink-900 hover:bg-ink-100 focus-visible:outline-none focus-visible:shadow-ring transition-colors"
        >
          {shown ? <EyeOff className="w-3.5 h-3.5" aria-hidden="true" /> : <Eye className="w-3.5 h-3.5" aria-hidden="true" />}
        </button>
      </div>
      {error ? (
        <span id={`${inputId}-err`} className="text-xs text-danger-600">{error}</span>
      ) : hint ? (
        <span id={`${inputId}-hint`} className="text-xs text-ink-500">{hint}</span>
      ) : null}
    </div>
  );
});

export default SecretInput;
