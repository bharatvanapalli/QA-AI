import React from 'react';
import { ChevronDown } from 'lucide-react';

export default function Select({
  label,
  hint,
  error,
  value,
  onChange,
  options = [],
  className = '',
  id,
  ...props
}) {
  const selectId = id || `sel-${label?.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={selectId} className="text-xs font-semibold text-ink-700">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          id={selectId}
          value={value}
          onChange={onChange}
          {...props}
          className={`h-10 w-full pl-3.5 pr-9 rounded-md border bg-white text-sm text-ink-900 appearance-none cursor-pointer
            transition-all duration-150 ease-out-soft
            focus:outline-none focus:border-ink-900 focus:shadow-ring
            ${error ? 'border-danger-400 focus:border-danger-500 focus:shadow-ring-rose' : 'border-ink-200 hover:border-ink-300'}
            ${className}`}
        >
          {options.map((o) =>
            typeof o === 'string' ? (
              <option key={o} value={o}>
                {o}
              </option>
            ) : (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            )
          )}
        </select>
        <ChevronDown className="w-3.5 h-3.5 text-ink-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
      {error ? (
        <span className="text-xs text-danger-600">{error}</span>
      ) : hint ? (
        <span className="text-xs text-ink-500">{hint}</span>
      ) : null}
    </div>
  );
}
