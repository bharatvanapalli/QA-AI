import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import api, { normaliseError } from '../lib/apiClient';
import { useAuth } from './auth';
import { useToast } from '../lib/useToast';

const ProjectCtx = createContext(null);
const LS_KEY = 'qaai.currentProjectId';

/**
 * Small in-memory fallback so this module still works when localStorage is
 * blocked (Safari private mode, Chrome's third-party cookie+storage blocks,
 * or any browser that throws on access). All previous code paths that hit
 * localStorage directly are routed through these helpers.
 */
const memoryStore = { value: null };
function safeStorageGet(key) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(key);
    }
  } catch (_) { /* private mode / blocked storage */ }
  return memoryStore.value;
}
function safeStorageSet(key, value) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, value);
      return;
    }
  } catch (_) { /* swallow */ }
  memoryStore.value = value;
}
function safeStorageRemove(key) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(key);
      return;
    }
  } catch (_) { /* swallow */ }
  memoryStore.value = null;
}

export function ProjectProvider({ children }) {
  const { status } = useAuth();
  const toast = useToast();
  const [projects, setProjects] = useState([]);
  const [current, setCurrent] = useState(null);
  const [loading, setLoading] = useState(true);
  // Remember which project we last actively pointed at so we can detect the
  // "active project just disappeared from the list" case across re-loads.
  const previousCurrentRef = useRef(null);
  // Remember the id we already complained about so we don't toast twice
  // for the same disappearance if load() fires repeatedly (React StrictMode
  // double-invocation in dev, or two quick refreshes).
  const reportedMissingRef = useRef(null);

  const load = useCallback(async () => {
    if (status !== 'authed') {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get('/projects');
      const list = res.projects || [];
      setProjects(list);

      const saved = safeStorageGet(LS_KEY);
      const savedProject = list.find((p) => p.id === saved);
      const prevId = previousCurrentRef.current;
      const prevProject = list.find((p) => p.id === prevId);
      const next = savedProject || prevProject || list[0] || null;

      // Detect the "current project was deleted out from under us" case:
      // we had a previously-active project, the persisted id pointed at it,
      // and the new list doesn't contain it. Warn the user instead of
      // silently jumping to whatever's first — it's surprising otherwise.
      // Guard against duplicate toasts when load() fires twice in quick
      // succession (StrictMode / rapid refresh).
      if (prevId && !prevProject && next && next.id !== prevId
          && reportedMissingRef.current !== prevId) {
        toast.error(`The previously selected project is no longer available. Switched to "${next.name}".`, { title: 'Project changed' });
        reportedMissingRef.current = prevId;
      }

      setCurrent(next);
      previousCurrentRef.current = next?.id || null;
      if (next) safeStorageSet(LS_KEY, next.id);
      else safeStorageRemove(LS_KEY);
    } catch (err) {
      const apiErr = normaliseError(err);
      console.error('[project] load failed', apiErr);
      // Don't toast on every load failure — the dashboard etc. surface their
      // own errors. Just leave projects empty so the rest of the UI degrades
      // gracefully.
    } finally {
      setLoading(false);
    }
  }, [status, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const switchTo = useCallback(
    (id) => {
      const p = projects.find((x) => x.id === id);
      if (p) {
        setCurrent(p);
        previousCurrentRef.current = p.id;
        safeStorageSet(LS_KEY, id);
      }
    },
    [projects]
  );

  const refresh = useCallback(() => load(), [load]);

  // Memoise so consumers' useCallback(load, [..., current]) doesn't refire on
  // unrelated re-renders. setProjects/setCurrent identities are stable from
  // useState; the rest depend on the listed memo deps.
  const value = useMemo(
    () => ({ projects, current, loading, switchTo, refresh, setProjects, setCurrent }),
    [projects, current, loading, switchTo, refresh]
  );
  return <ProjectCtx.Provider value={value}>{children}</ProjectCtx.Provider>;
}

export function useProject() {
  const ctx = useContext(ProjectCtx);
  if (!ctx) throw new Error('useProject must be inside ProjectProvider');
  return ctx;
}

// Exported for unit tests so they can stub localStorage behaviour directly.
export const __test__ = { safeStorageGet, safeStorageSet, safeStorageRemove, LS_KEY };
