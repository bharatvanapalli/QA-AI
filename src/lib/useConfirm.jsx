import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import ConfirmDialog from '../components/ui/ConfirmDialog';

/**
 * Promise-based confirmation. Mount <ConfirmProvider> once near the top of
 * the tree; anywhere below, `const confirm = useConfirm()` returns a fn that
 * opens the modal and resolves to true (confirmed) or false (cancelled).
 *
 *   const ok = await confirm({
 *     title: 'Delete project?',
 *     message: 'All test cases will be permanently removed.',
 *     confirmLabel: 'Delete project',
 *     requireTypedName: project.name,
 *   });
 *   if (!ok) return;
 */
const ConfirmCtx = createContext(null);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState({ open: false, opts: {}, loading: false });
  const resolverRef = useRef(null);

  const confirm = useCallback((opts = {}) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setState({ open: true, opts, loading: false });
    });
  }, []);

  const resolve = useCallback((value) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setState((s) => ({ ...s, open: false, loading: false }));
    if (r) r(value);
  }, []);

  // Allow the caller to flip the dialog into a loading state during async
  // work (e.g. server call before closing). Confirm handlers can pass a
  // function that returns a promise — we surface the spinner while it runs.
  const onConfirm = useCallback(async () => {
    const { opts } = state;
    if (typeof opts.onConfirm === 'function') {
      setState((s) => ({ ...s, loading: true }));
      try {
        await opts.onConfirm();
      } finally {
        resolve(true);
      }
    } else {
      resolve(true);
    }
  }, [state, resolve]);

  const onCancel = useCallback(() => resolve(false), [resolve]);

  const ctxValue = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmCtx.Provider value={ctxValue}>
      {children}
      <ConfirmDialog
        open={state.open}
        title={state.opts.title}
        message={state.opts.message}
        confirmLabel={state.opts.confirmLabel}
        cancelLabel={state.opts.cancelLabel}
        variant={state.opts.variant}
        requireTypedName={state.opts.requireTypedName}
        loading={state.loading}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error('useConfirm must be inside ConfirmProvider');
  return ctx;
}
