import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { AlertTriangle, CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { sanitizeUiMessage } from './userFacingMessages';

const ToastCtx = createContext(null);

// Cap visible toasts so a burst of errors never floods the screen. Oldest
// drops first when the cap is exceeded.
const MAX_TOASTS = 5;

let _id = 0;
const nextId = () => ++_id;

function cleanToastMessage(message, opts = {}) {
  return sanitizeUiMessage(message, opts);
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (kind, message, opts = {}) => {
      const id = nextId();
      const t = { id, kind, message: cleanToastMessage(message, opts), title: opts.title };
      setToasts((all) => {
        if (kind === 'error') {
          const newest = all[all.length - 1];
          if (newest && newest.kind === kind && newest.message === t.message && newest.title === t.title) {
            return all;
          }
        }
        const next = [...all, t];
        return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
      });
      // Errors stay longer so screen readers and humans both have time to catch
      // them; success/info auto-dismiss faster. ttl: 0 keeps the toast pinned.
      const ttl = opts.ttl ?? (kind === 'error' ? 8000 : kind === 'warning' ? 6000 : 4000);
      if (ttl > 0) setTimeout(() => dismiss(id), ttl);
      return id;
    },
    [dismiss]
  );

  // Memoise the context value so consumers' useCallback(load, [..., toast])
  // hooks don't refire after every render of <ToastProvider>. push/dismiss
  // identities are stable (both created via useCallback), so the value is
  // genuinely stable across renders.
  const value = useMemo(
    () => ({
      success: (m, o) => push('success', m, o),
      error: (m, o) => push('error', m, o),
      warning: (m, o) => push('warning', m, o),
      info: (m, o) => push('info', m, o),
      dismiss,
    }),
    [push, dismiss]
  );

  return (
    <ToastCtx.Provider value={value}>
      {children}
      {/* Region wrapper: pointer-events-none so the toast stack never blocks
          clicks behind it, but individual toasts opt back in to receive
          dismiss clicks. role+aria-live make the region announceable. */}
      <div
        className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-[360px] pointer-events-none"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        {toasts.map((t) => {
          const isError = t.kind === 'error';
          const isWarning = t.kind === 'warning';
          const colors =
            t.kind === 'success'
              ? 'bg-success-50 border-success-200 text-success-900'
              : isError
              ? 'bg-danger-50 border-danger-200 text-danger-900'
              : isWarning
              ? 'bg-warn-50 border-warn-200 text-warn-900'
              : 'bg-info-50 border-info-200 text-info-900';
          const Icon = t.kind === 'success' ? CheckCircle2 : isError ? XCircle : isWarning ? AlertTriangle : Info;
          return (
            <div
              key={t.id}
              // Error toasts use role="alert" + aria-live="assertive" so they
              // interrupt screen readers immediately; non-error toasts use
              // role="status" + aria-live="polite" so they don't interrupt
              // ongoing speech. aria-atomic makes the whole toast announce as
              // one phrase rather than letter-by-letter on update.
              role={isError ? 'alert' : 'status'}
              aria-live={isError ? 'assertive' : 'polite'}
              aria-atomic="true"
              className={`pointer-events-auto rounded-lg border shadow-sm px-3 py-2.5 flex gap-2 items-start text-sm toast-enter ${colors}`}
            >
              <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                {t.title && <div className="font-semibold">{t.title}</div>}
                <div className="break-words">{t.message}</div>
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="opacity-60 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current rounded shrink-0"
                aria-label="Dismiss notification"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be inside ToastProvider');
  return ctx;
}
