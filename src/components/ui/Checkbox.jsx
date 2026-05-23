import React from 'react';
import { Check } from 'lucide-react';

export default function Checkbox({ checked, onChange, label, hint, disabled = false }) {
  return (
    <label
      className={`flex items-start gap-2.5 group select-none ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      <span
        className={`inline-flex items-center justify-center w-4 h-4 mt-0.5 rounded border transition-all duration-150 ease-out-soft shrink-0
          ${checked
            ? 'bg-ink-900 border-ink-900 text-white shadow-sm'
            : 'bg-white border-ink-300 group-hover:border-ink-500'}`}
      >
        {checked && <Check className="w-3 h-3" strokeWidth={3} />}
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={!!checked}
        onChange={(e) => onChange?.(e.target.checked)}
        disabled={disabled}
      />
      <span className="flex-1 min-w-0">
        {label && <span className="text-sm text-ink-900 leading-tight">{label}</span>}
        {hint && <div className="text-xs text-ink-500 mt-0.5">{hint}</div>}
      </span>
    </label>
  );
}
