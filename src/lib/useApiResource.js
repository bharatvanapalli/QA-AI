import { useCallback, useEffect, useRef, useState } from 'react';
import api, { normaliseError } from './apiClient';

/**
 * useApiResource — kills the `setLoading + try/catch/finally + toast.error`
 * boilerplate that was being duplicated in every page.
 *
 *   const { data, error, loading, refetch } = useApiResource(
 *     `/projects/${projectId}/scenarios`,
 *     { enabled: !!projectId }
 *   );
 *
 * Returns:
 *   data     — the parsed response body, or initialData until first load
 *   error    — an ApiError (never a plain Error) or null
 *   loading  — true while a request is in flight
 *   refetch  — () => void, manually refire the request
 *
 * Cancellation: if the path/deps change or the component unmounts while a
 * request is in flight, the late response is dropped (the abort signal is
 * passed to apiClient too). Replaces the manual `let cancelled = false`
 * pattern that almost every page was reinventing.
 *
 * Why not SWR / TanStack Query: those bring a peer-dep + cache layer; this
 * hook is a strict subset for pages that already have local UI state and
 * just want the network-call boilerplate consolidated. SWR is the right
 * next step once we want client-side caching + revalidation.
 */
export default function useApiResource(path, opts = {}) {
  const {
    enabled = true,
    initialData = null,
    deps = [],
    onSuccess,
    onError,
  } = opts;

  const [data, setData] = useState(initialData);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled);

  // Track the latest request so callbacks from stale ones don't update state.
  const reqIdRef = useRef(0);

  const fetcher = useCallback(
    async (signal) => {
      const myId = ++reqIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const body = await api.get(path, { signal });
        if (reqIdRef.current !== myId) return; // newer request superseded us
        setData(body);
        onSuccess?.(body);
      } catch (err) {
        if (reqIdRef.current !== myId) return;
        const apiErr = normaliseError(err);
        if (apiErr.code === 'ABORTED') return; // unmount / new req — silent
        setError(apiErr);
        onError?.(apiErr);
      } finally {
        if (reqIdRef.current === myId) setLoading(false);
      }
    },
    // path is intentional; onSuccess/onError captured by closure since they
    // may not be memoised by callers and we don't want to refire on identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path]
  );

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    fetcher(ctrl.signal);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fetcher, ...deps]);

  const refetch = useCallback(() => {
    const ctrl = new AbortController();
    fetcher(ctrl.signal);
    return () => ctrl.abort();
  }, [fetcher]);

  return { data, error, loading, refetch, setData };
}
