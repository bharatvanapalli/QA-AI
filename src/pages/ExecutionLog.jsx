import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Terminal, Trash2, Play, ChevronRight, Loader2 } from 'lucide-react';
import api from '../lib/apiClient';
import { useProject } from '../store/project';
import { useRunStream } from '../store/runStream';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import StatusBadge from '../components/ui/StatusBadge';

export default function ExecutionLog() {
  const navigate = useNavigate();
  const { current } = useProject();
  const { log, running, connected, clearLog, latestRunId, latestSummary } = useRunStream();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const logRef = useRef(null);

  useEffect(() => {
    if (!current) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const res = await api.get(`/runs?projectId=${current.id}&limit=20`);
        setHistory(res.runs || []);
      } catch (_) {}
      setLoading(false);
    })();
  }, [current, latestRunId, latestSummary]);

  useEffect(() => {
    // Auto-scroll log to bottom on new lines
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Execution Log"
        subtitle={
          running
            ? 'Run in progress…'
            : connected
            ? 'Live stream connected'
            : 'Stream disconnected — reconnecting…'
        }
      >
        <Button size="sm" variant="ghost" onClick={clearLog} disabled={!log.length}>
          <Trash2 className="w-3.5 h-3.5" />
          Clear log
        </Button>
      </PageHeader>

      <main className="flex-1 grid grid-cols-[1fr_320px] overflow-hidden bg-ink-50">
        {/* Live log */}
        <section className="overflow-hidden flex flex-col p-4">
          <div className="flex items-center gap-2 mb-2 text-xs text-ink-500">
            <Terminal className="w-3.5 h-3.5" />
            <span>Streaming output</span>
            <span
              className={`ml-2 w-1.5 h-1.5 rounded-full ${
                connected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
              }`}
            />
            {running && <Loader2 className="w-3 h-3 animate-spin ml-2" />}
          </div>
          <div
            ref={logRef}
            className="flex-1 overflow-y-auto rounded-lg bg-ink-900 text-emerald-300 font-mono text-xs p-3 leading-relaxed"
          >
            {log.length === 0 ? (
              <div className="text-ink-500 italic">
                {connected
                  ? 'Idle — start a run from the Test Cases page to see live output.'
                  : 'Not connected. Sign in or check the server.'}
              </div>
            ) : (
              log.map((line, i) => <div key={i}>{line}</div>)
            )}
          </div>
        </section>

        {/* History panel */}
        <aside className="border-l border-ink-200 bg-white overflow-y-auto p-4">
          <h2 className="text-xs font-bold text-ink-700 uppercase tracking-wider mb-3">
            Recent runs
          </h2>
          {loading ? (
            <div className="text-xs text-ink-500">Loading…</div>
          ) : history.length === 0 ? (
            <EmptyState
              icon={Play}
              title="No runs yet"
              message="Approve test cases and click Run to begin."
            />
          ) : (
            <div className="space-y-2">
              {history.map((r) => (
                <button
                  key={r.id}
                  onClick={() => navigate(`/reports?runId=${r.id}`)}
                  className="w-full text-left rounded-md border border-ink-200 p-2.5 hover:bg-ink-50"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-ink-900 truncate">
                      {r.sprintName}
                    </span>
                    <StatusBadge
                      status={
                        r.status === 'completed'
                          ? 'valid'
                          : r.status === 'failed' || r.status === 'cancelled'
                          ? 'invalid'
                          : 'validating'
                      }
                      label={r.status}
                    />
                  </div>
                  <div className="text-xs text-ink-500 mt-0.5 flex items-center justify-between">
                    <span>
                      ✅ {r.passed} · ❌ {r.failed} · ⛔ {r.blocked ?? 0}
                      {(r.skipped ?? 0) > 0 ? ` · ⏭ ${r.skipped}` : ''}
                    </span>
                    <ChevronRight className="w-3 h-3" />
                  </div>
                  <div className="text-2xs text-ink-400 mt-0.5">
                    {new Date(r.startedAt).toLocaleString()}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
