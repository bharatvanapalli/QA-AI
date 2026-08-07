import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import api, { normaliseError } from '../lib/apiClient';
import { useAuth } from './auth';
import { useToast } from '../lib/useToast';

const ProjectCtx = createContext(null);
const LS_KEY = 'qaai.currentProjectId';
// Persist the active sprint per project (Phase B / B3). Stored under
// `qaai.currentSprintId:<projectId>` so switching projects restores each
// project's last-chosen sprint independently.
const sprintLsKey = (projectId) => `qaai.currentSprintId:${projectId}`;
// Persist the active scenario generation per project (versioning). Selecting a
// past generation re-skins Test Cases / Overview / Reports to that batch.
const genLsKey = (projectId) => `qaai.currentGenerationId:${projectId}`;

/**
 * Small in-memory fallback so this module still works when localStorage is
 * blocked (Safari private mode, Chrome's third-party cookie+storage blocks,
 * or any browser that throws on access). All previous code paths that hit
 * localStorage directly are routed through these helpers.
 */
// Map-based fallback so multiple distinct keys (project id, sprint id per
// project) don't overwrite each other — the old single-value slot caused
// safeStorageGet(LS_KEY) to return the sprint id after safeStorageSet was
// called for a sprint key in Safari private mode.
const memoryStore = new Map();
function safeStorageGet(key) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(key);
    }
  } catch (_) { /* private mode / blocked storage */ }
  return memoryStore.get(key) ?? null;
}
function safeStorageSet(key, value) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, value);
      return;
    }
  } catch (_) { /* swallow */ }
  memoryStore.set(key, value);
}
function safeStorageRemove(key) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(key);
      return;
    }
  } catch (_) { /* swallow */ }
  memoryStore.delete(key);
}

export function ProjectProvider({ children }) {
  const { status } = useAuth();
  const toast = useToast();
  const [projects, setProjects] = useState([]);
  const [current, setCurrent] = useState(null);
  const [loading, setLoading] = useState(true);
  // Sprint state (Phase B / B3). `sprints` is the list for the current
  // project; `currentSprint` is the active selection (null = "all data").
  const [sprints, setSprints] = useState([]);
  const [currentSprintId, setCurrentSprintId] = useState(null);
  // Scenario-generation state (versioning). `generations` is the list for the
  // current project; `currentGenerationId` is the active selection that scopes
  // Test Cases / Overview / Reports. null = "current generation" (the default).
  const [generations, setGenerations] = useState([]);
  const [currentGenerationId, setCurrentGenerationId] = useState(null);
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
      const list = res?.projects || [];
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
        // Sprints belong to the project — clear the in-memory list; the
        // effect below re-fetches for the newly-active project.
        setSprints([]);
        setCurrentSprintId(null);
        setGenerations([]);
        setCurrentGenerationId(null);
      }
    },
    [projects]
  );

  const refresh = useCallback(() => load(), [load]);

  // Refetch the current project's sprints. Public so pages that mutate
  // sprints (ProjectSetup) can request a refresh without round-tripping.
  const refreshSprints = useCallback(async () => {
    if (!current) {
      setSprints([]);
      setCurrentSprintId(null);
      return;
    }
    try {
      const res = await api.get(`/projects/${current.id}/sprints`);
      const list = res?.sprints || [];
      setSprints(list);
      // Pick a default active sprint: persisted choice if still valid;
      // otherwise the most recently-updated in_progress sprint; otherwise
      // null (= "no sprint, show everything" — preserves legacy UX).
      const saved = safeStorageGet(sprintLsKey(current.id));
      const stillValid = list.find((s) => s.id === saved);
      const inProgress = list.find((s) => s.lifecycle === 'in_progress');
      const next = stillValid || inProgress || null;
      setCurrentSprintId(next?.id || null);
      if (next) safeStorageSet(sprintLsKey(current.id), next.id);
      else safeStorageRemove(sprintLsKey(current.id));
    } catch (err) {
      console.error('[project] refreshSprints failed', err);
      setSprints([]);
      setCurrentSprintId(null);
    }
  }, [current]);

  useEffect(() => {
    refreshSprints();
  }, [refreshSprints]);

  const switchSprint = useCallback(
    (sprintId) => {
      // sprintId === null means "no sprint scope" (show project-wide data).
      setCurrentSprintId(sprintId || null);
      if (!current) return;
      if (sprintId) safeStorageSet(sprintLsKey(current.id), sprintId);
      else safeStorageRemove(sprintLsKey(current.id));
    },
    [current]
  );

  const currentSprint = useMemo(
    () => (currentSprintId ? sprints.find((s) => s.id === currentSprintId) || null : null),
    [sprints, currentSprintId]
  );

  // Refetch the current project's scenario generations. Always defaults to the
  // backend-authoritative isCurrent generation — localStorage is NOT consulted
  // here because a stale localStorage pointer silently filters out all runs
  // from newer generations. Users who want to view history use the picker
  // (switchGeneration below), which is session-only and doesn't persist.
  const refreshGenerations = useCallback(async () => {
    if (!current) {
      setGenerations([]);
      setCurrentGenerationId(null);
      return;
    }
    try {
      const res = await api.get(`/projects/${current.id}/scenarios/generations`);
      const list = res?.generations || [];
      setGenerations(list);
      // Clear any stale localStorage entry so it can never re-pin the wrong gen.
      safeStorageRemove(genLsKey(current.id));
      const next = list.find((g) => g.isCurrent) || list[0] || null;
      setCurrentGenerationId(next?.id || null);
    } catch (err) {
      console.error('[project] refreshGenerations failed', err);
      setGenerations([]);
      setCurrentGenerationId(null);
    }
  }, [current]);

  useEffect(() => {
    refreshGenerations();
  }, [refreshGenerations]);

  const switchGeneration = useCallback(
    (generationId) => {
      // Session-only — does not persist to localStorage. On next page load the
      // store always resets to isCurrent (the default above). This prevents the
      // "viewed v1 once → all v2 runs disappeared forever" class of bug.
      setCurrentGenerationId(generationId || null);
    },
    []
  );

  const currentGeneration = useMemo(
    () => (currentGenerationId ? generations.find((g) => g.id === currentGenerationId) || null : null),
    [generations, currentGenerationId]
  );

  // Memoise so consumers' useCallback(load, [..., current]) doesn't refire on
  // unrelated re-renders. setProjects/setCurrent identities are stable from
  // useState; the rest depend on the listed memo deps.
  const value = useMemo(
    () => ({
      projects, current, loading, switchTo, refresh, setProjects, setCurrent,
      sprints, currentSprint, currentSprintId, switchSprint, refreshSprints,
      generations, currentGeneration, currentGenerationId, switchGeneration, refreshGenerations,
    }),
    [projects, current, loading, switchTo, refresh, sprints, currentSprint, currentSprintId, switchSprint, refreshSprints,
     generations, currentGeneration, currentGenerationId, switchGeneration, refreshGenerations]
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
