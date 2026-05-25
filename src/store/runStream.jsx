import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useAuth } from './auth';
import { useProject } from './project';

const RunStreamCtx = createContext(null);

/**
 * Resolve the WebSocket URL.
 *   - Honour VITE_WS_URL if set (explicit override, used by dev with a
 *     separate API host).
 *   - Otherwise derive from window.location: `wss://host/ws` (or `ws://`
 *     for HTTP origins). This is what production deployments behind a
 *     single host should use — no hardcoded localhost fallback that
 *     silently fails in prod.
 */
function resolveWsUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  if (typeof window !== 'undefined' && window.location) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return 'ws://localhost:5000';
}

// Exponential backoff with jitter — caps at 30 s so server bounces don't
// thunder-herd from N clients hammering at the same fixed 2 s interval.
function nextBackoff(attempt) {
  const base = Math.min(30_000, 1_000 * 2 ** attempt); // 1, 2, 4, 8, 16, 30
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

export function RunStreamProvider({ children }) {
  const { status } = useAuth();
  const { current } = useProject();
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState([]);
  const [latestRunId, setLatestRunId] = useState(null);
  const [latestSummary, setLatestSummary] = useState(null);
  const [running, setRunning] = useState(false);
  // Live Claude rate-limit snapshot — populated by `claude.rate-limit` WS
  // events emitted server-side after every agent call. Used by the Reports
  // page header to render a current-minute TPM-remaining chip. Null until
  // the first Claude call lands; resets to null on project switch (below).
  const [claudeRateLimit, setClaudeRateLimit] = useState(null);
  // Phase E1.4 — last accessibility-tree preview from the MCP layer. Powers
  // the Theater DOM snapshot pane so the operator can see exactly what the
  // agent is looking at. Cleared on project switch; updated on every
  // mcp.snapshot.preview broadcast (~once per tool call).
  const [mcpSnapshot, setMcpSnapshot] = useState(null);
  const wsRef = useRef(null);
  const listenersRef = useRef(new Set());

  // Per-project state must reset when the user switches projects — otherwise
  // the in-memory latestRunId / latestSummary / log carries over from
  // project A and quietly contaminates project B's UI (e.g. the Overview
  // shows a "latest run" that belongs to a different project).
  useEffect(() => {
    setLog([]);
    setLatestRunId(null);
    setLatestSummary(null);
    setRunning(false);
    // Rate-limit snapshot is per-API-key not per-project, but resetting it
    // on project switch avoids stale "0 tokens remaining" frightening the
    // user when the project changes context. The next Claude call repopulates.
    setClaudeRateLimit(null);
    setMcpSnapshot(null);
  }, [current?.id]);

  const subscribe = useCallback((fn) => {
    listenersRef.current.add(fn);
    return () => listenersRef.current.delete(fn);
  }, []);

  useEffect(() => {
    if (status !== 'authed') return;
    let ws;
    let reconnectTimer;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      ws = new WebSocket(resolveWsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) {
          const delay = nextBackoff(attempt);
          attempt += 1;
          reconnectTimer = setTimeout(connect, delay);
        }
      };
      ws.onerror = () => {
        // close handler will retry
      };
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === 'log') {
          setLog((prev) => {
            const next = [...prev, msg.message];
            return next.length > 500 ? next.slice(-500) : next;
          });
        }
        if (msg.type === 'run.started') {
          setLatestRunId(msg.runId);
          setLatestSummary(null);
          setRunning(true);
        }
        if (msg.type === 'run.complete') {
          setLatestSummary(msg.summary || null);
          setRunning(false);
        }
        if (msg.type === 'claude.rate-limit') {
          // Drop the `type` field — keep the structured tokens/requests/capturedAt.
          const { type, ...rest } = msg;
          setClaudeRateLimit(rest);
        }
        if (msg.type === 'mcp.snapshot.preview') {
          // { sessionId, tool, snapshot, truncated, length, ts }
          const { type, ...rest } = msg;
          setMcpSnapshot(rest);
        }
        for (const fn of listenersRef.current) {
          try {
            fn(msg);
          } catch (_) {}
        }
      };
    };
    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    };
  }, [status]);

  const clearLog = useCallback(() => setLog([]), []);

  const value = useMemo(
    () => ({
      connected,
      log,
      latestRunId,
      latestSummary,
      running,
      claudeRateLimit,
      mcpSnapshot,
      clearLog,
      subscribe,
      setRunning,
    }),
    [connected, log, latestRunId, latestSummary, running, claudeRateLimit, mcpSnapshot, clearLog, subscribe]
  );

  return <RunStreamCtx.Provider value={value}>{children}</RunStreamCtx.Provider>;
}

export function useRunStream() {
  const ctx = useContext(RunStreamCtx);
  if (!ctx) throw new Error('useRunStream must be inside RunStreamProvider');
  return ctx;
}
