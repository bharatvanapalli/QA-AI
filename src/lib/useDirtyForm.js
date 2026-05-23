import { useState, useCallback, useRef, useEffect, useMemo } from 'react';

/**
 * Tracks form state and whether values differ from a baseline.
 *
 * Usage:
 *   const f = useDirtyForm({ apiKey: '', model: 'claude-sonnet-4-6' });
 *   <input value={f.values.apiKey} onChange={e => f.set('apiKey', e.target.value)} />
 *   <button disabled={!f.isDirty}>Save</button>
 *   await save(f.values);
 *   f.commit(); // baseline now = current values
 */
export default function useDirtyForm(initial) {
  const baselineRef = useRef({ ...initial });
  const [values, setValues] = useState({ ...initial });
  const [errors, setErrors] = useState({});

  const set = useCallback((key, value) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const setMany = useCallback((patch) => {
    setValues((prev) => ({ ...prev, ...patch }));
  }, []);

  const setError = useCallback((key, msg) => {
    setErrors((prev) => ({ ...prev, [key]: msg }));
  }, []);

  const clearErrors = useCallback(() => setErrors({}), []);

  const reset = useCallback(() => {
    setValues({ ...baselineRef.current });
    setErrors({});
  }, []);

  const commit = useCallback(
    (next) => {
      baselineRef.current = next ? { ...next } : { ...values };
      if (next) setValues({ ...next });
      setErrors({});
    },
    [values]
  );

  const rebase = useCallback((next) => {
    baselineRef.current = { ...next };
    setValues({ ...next });
    setErrors({});
  }, []);

  const isDirty = useMemo(() => {
    const keys = new Set([
      ...Object.keys(values),
      ...Object.keys(baselineRef.current),
    ]);
    for (const k of keys) {
      const a = values[k];
      const b = baselineRef.current[k];
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return true;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
      } else if (a !== b) {
        return true;
      }
    }
    return false;
  }, [values]);

  return { values, errors, set, setMany, setError, clearErrors, reset, commit, rebase, isDirty };
}

/**
 * Used to warn on browser navigation away with unsaved changes.
 */
export function useUnsavedChangesWarning(isDirty, message = 'You have unsaved changes.') {
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = message;
      return message;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty, message]);
}
