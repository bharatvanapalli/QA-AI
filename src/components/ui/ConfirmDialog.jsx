import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import Button from './Button';
import Input from './Input';

/**
 * Modal confirmation dialog. Replaces window.confirm() for destructive actions.
 *
 * Props:
 *   open               — boolean
 *   title              — string
 *   message            — string | ReactNode (optional)
 *   confirmLabel       — string, default 'Confirm'
 *   cancelLabel        — string, default 'Cancel'
 *   variant            — 'danger' | 'primary', default 'danger'
 *   requireTypedName   — when set, confirm stays disabled until input matches
 *   loading            — shows spinner on confirm button
 *   onConfirm() / onCancel()
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  requireTypedName,
  loading = false,
  onConfirm,
  onCancel,
}) {
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!open) return;
    setTyped('');
    const t = setTimeout(() => {
      if (requireTypedName && inputRef.current) {
        inputRef.current.focus();
      } else {
        // Focus the first interactive control inside the dialog (close X by
        // default, or the cancel button if X is removed).
        const firstBtn = dialogRef.current?.querySelector('button[data-default-focus="true"]');
        firstBtn?.focus();
      }
    }, 0);
    return () => clearTimeout(t);
  }, [open, requireTypedName]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !loading) onCancel?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, loading, onCancel]);

  if (!open) return null;

  const typedOk = !requireTypedName || typed.trim() === requireTypedName;
  const confirmDisabled = loading || !typedOk;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-ink-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel?.();
      }}
    >
      <div ref={dialogRef} className="bg-white rounded-xl shadow-xl max-w-md w-full p-5 border border-ink-200">
        <div className="flex items-start gap-3 mb-4">
          {variant === 'danger' && (
            <div className="w-9 h-9 rounded-full bg-danger-50 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5 text-danger-600" aria-hidden="true" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h2 id="confirm-dialog-title" className="font-semibold text-ink-900">{title}</h2>
            {message && (
              <div className="text-sm text-ink-600 mt-1.5 leading-relaxed">{message}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => !loading && onCancel?.()}
            className="text-ink-400 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-ring rounded p-0.5"
            aria-label="Close"
            disabled={loading}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {requireTypedName && (
          <div className="mb-4">
            <Input
              ref={inputRef}
              label={`Type "${requireTypedName}" to confirm`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck="false"
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-ink-200">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={loading}
            data-default-focus="true"
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'danger' ? 'danger' : 'primary'}
            size="sm"
            onClick={onConfirm}
            disabled={confirmDisabled}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
