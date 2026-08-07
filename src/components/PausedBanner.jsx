import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Hand, ArrowRight, Clock4 } from 'lucide-react';
import { useRunStream } from '../store/runStream';
import { useProject } from '../store/project';
import api from '../lib/apiClient';

/**
 * Slim, sticky-top banner shown on every page when a conductor run is paused
 * waiting on the operator. The PauseModal overlay handles the full prompt &
 * verdict UI — this banner exists for the rare moment the operator dismissed
 * a modal by accident and walked away. The banner gives them a one-click
 * route back to the Live Pipeline.
 *
 * Hidden on the Live Pipeline page itself (the page already owns the pause
 * affordance via the modal, so a banner there would be redundant chrome).
 */
export default function PausedBanner() {
  const { current } = useProject();
  const { subscribe } = useRunStream();
  const location = useLocation();
  const navigate = useNavigate();
  const [pause, setPause] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  // Reconnect on mount — survive refresh / cross-page nav.
  useEffect(() => {
    if (!current?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get(`/projects/${current.id}/agents/pending-pauses`);
        if (cancelled) return;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        const mine = pending.filter((p) => !p.projectId || p.projectId === current.id);
        if (mine.length) setPause(mine[0]);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, [current?.id]);

  useEffect(() => {
    if (!subscribe) return;
    const unsub = subscribe((msg) => {
      if (msg.projectId && current?.id && msg.projectId !== current.id) return;
      if (msg.type === 'agent.awaitingInput') {
        setPause({
          runId: msg.runId,
          tcId: msg.tcId,
          tcName: msg.tcName || null,
          stepIndex: msg.stepIndex,
          prompt: msg.prompt,
          deadline: typeof msg.deadline === 'number' ? msg.deadline : Date.now() + 5 * 60 * 1000,
        });
      } else if (msg.type === 'agent.inputResolved') {
        setPause((prev) => {
          if (!prev) return null;
          if (prev.runId === msg.runId && prev.tcId === msg.tcId && prev.stepIndex === msg.stepIndex) {
            return null;
          }
          return prev;
        });
      } else if (msg.type === 'run.complete' || (msg.type === 'agent.phase.complete' && msg.cancelled)) {
        setPause(null);
      }
    });
    return unsub;
  }, [subscribe, current?.id]);

  useEffect(() => {
    if (!pause) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pause?.runId, pause?.tcId, pause?.stepIndex]);

  const remainingMs = pause ? Math.max(0, pause.deadline - now) : 0;
  const remainingLabel = useMemo(() => {
    const totalSec = Math.ceil(remainingMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }, [remainingMs]);

  // Don't render on Live Pipeline — the modal does that work there.
  if (!pause || location.pathname.startsWith('/live-pipeline')) return null;

  const lowTime = remainingMs > 0 && remainingMs < 30_000;

  return (
    <div
      className={`sticky top-0 z-40 border-b ${lowTime ? 'bg-danger-50 border-danger-200' : 'bg-info-50 border-info-200'} px-4 py-2 flex items-center gap-3`}
      role="status"
      aria-live="polite"
    >
      <div className={`w-7 h-7 rounded-full ${lowTime ? 'bg-danger-600' : 'bg-info-600'} text-white flex items-center justify-center shrink-0`}>
        <Hand className="w-4 h-4" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-ink-900 truncate">
          Run paused &mdash; your input is required
          {pause.tcName && <span className="font-normal text-ink-600"> &middot; {pause.tcName}</span>}
        </div>
        <div className="text-[11px] text-ink-600 truncate mt-0.5 flex items-center gap-1.5">
          <Clock4 className={`w-3 h-3 ${lowTime ? 'text-danger-600' : 'text-info-600'}`} aria-hidden="true" />
          <span>Auto-times out in {remainingLabel}</span>
          <span className="text-ink-400">&middot;</span>
          <span className="truncate">{pause.prompt}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => navigate('/live-pipeline')}
        className={`shrink-0 inline-flex items-center gap-1 text-xs font-semibold rounded-md px-3 py-1.5 transition-colors ${lowTime ? 'bg-danger-600 hover:bg-danger-700 text-white' : 'bg-info-600 hover:bg-info-700 text-white'}`}
      >
        Resume
        <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
