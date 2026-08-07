import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Loader2, Hand, X, Check, SkipForward, Ban, KeyRound, MessageSquareText,
  Clock4, Wifi, WifiOff,
} from 'lucide-react';
import { useRunStream } from '../store/runStream';
import { useProject } from '../store/project';
import api from '../lib/apiClient';
import Button from './ui/Button';

/**
 * Global pause/resume modal — singleton mounted at the app root.
 *
 * Listens for `agent.awaitingInput` over WS; renders a focused dialog that
 * blocks navigation-by-intent until the user picks one of: Continue (with
 * value), Skip, or Block. Sends the verdict back over the same socket as
 * an `agent.inputProvided` message — the paused conductor resumes the
 * tool-use loop with the user's input fed in as the synthetic tool result.
 *
 * Survives navigation and refresh: on mount we GET /agents/pending-pauses
 * so the modal reappears even if the user reloaded the tab between when
 * the agent paused and when the user came back.
 */
export default function PauseModal() {
  const { current } = useProject();
  const { subscribe, send, connected } = useRunStream();

  // The currently-shown pause. Shape: { runId, tcId, tcName?, stepIndex, prompt, inputType, options, deadline }.
  const [pause, setPause] = useState(null);
  const [textValue, setTextValue] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState('input'); // input | confirming-block | resolved
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef(null);
  const closeBtnRef = useRef(null);

  // ── Reconnect: on mount, fetch any pending pause and seed the modal.
  useEffect(() => {
    if (!current?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get(`/projects/${current.id}/agents/pending-pauses`);
        if (cancelled) return;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        // Filter to THIS project — the registry is in-memory and not
        // project-scoped at the storage level, so the listing may include
        // pauses for other projects this user has running.
        const mine = pending.filter((p) => !p.projectId || p.projectId === current.id);
        if (!mine.length) return;
        // Take the first pending pause — the registry only allows one per
        // (runId, tcId, stepIndex) key, and the typical case is exactly one.
        const p = mine[0];
        setPause(p);
        setTextValue('');
        setReason('');
        setPhase('input');
      } catch (_) {
        // Pending-pauses lookup is best-effort. If it fails the modal will
        // still pop the moment the next WS agent.awaitingInput lands.
      }
    })();
    return () => { cancelled = true; };
  }, [current?.id]);

  // ── Subscribe to WS pause/resolve events.
  useEffect(() => {
    if (!subscribe) return;
    const unsub = subscribe((msg) => {
      // Cross-project guard — never surface a pause from a different project.
      if (msg.projectId && current?.id && msg.projectId !== current.id) return;

      if (msg.type === 'agent.awaitingInput') {
        setPause({
          runId: msg.runId,
          tcId: msg.tcId,
          tcName: msg.tcName || null,
          stepIndex: msg.stepIndex,
          prompt: msg.prompt,
          inputType: msg.inputType || 'confirm',
          options: Array.isArray(msg.options) ? msg.options : null,
          deadline: typeof msg.deadline === 'number' ? msg.deadline : (Date.now() + 5 * 60 * 1000),
        });
        setTextValue('');
        setReason('');
        setPhase('input');
        setSubmitting(false);
      } else if (msg.type === 'agent.inputResolved') {
        // Conductor confirmed resolution — close the modal.
        setPause((prev) => {
          if (!prev) return null;
          if (prev.runId === msg.runId && prev.tcId === msg.tcId && prev.stepIndex === msg.stepIndex) {
            return null;
          }
          return prev;
        });
      } else if (msg.type === 'run.complete' || (msg.type === 'agent.phase.complete' && msg.cancelled)) {
        // Run ended for any reason — clear the modal so the user isn't stuck.
        setPause(null);
      }
    });
    return unsub;
  }, [subscribe, current?.id]);

  // ── Countdown tick. Only run when there's an active pause.
  useEffect(() => {
    if (!pause) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pause?.runId, pause?.tcId, pause?.stepIndex]);

  // ── Focus management when the modal opens.
  useEffect(() => {
    if (!pause) return;
    const t = setTimeout(() => {
      if (pause.inputType === 'text' && inputRef.current) inputRef.current.focus();
      else if (closeBtnRef.current) closeBtnRef.current.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [pause?.runId, pause?.tcId, pause?.stepIndex, pause?.inputType]);

  // ── Esc to dismiss → treat as Skip (least destructive non-Continue action).
  useEffect(() => {
    if (!pause) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !submitting && phase === 'input') {
        // Don't auto-skip — that's too aggressive. Just blur focus.
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pause, submitting, phase]);

  const remainingMs = pause ? Math.max(0, pause.deadline - now) : 0;
  const remainingLabel = useMemo(() => {
    const totalSec = Math.ceil(remainingMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }, [remainingMs]);
  const lowTime = remainingMs > 0 && remainingMs < 30_000;

  const submit = useCallback((action, payload = {}) => {
    if (!pause || submitting) return;
    const okIfText = action !== 'continue' || pause.inputType === 'confirm' || (typeof payload.value === 'string' && payload.value.length);
    if (!okIfText) return;
    setSubmitting(true);
    const msg = {
      type: 'agent.inputProvided',
      runId: pause.runId,
      tcId: pause.tcId,
      stepIndex: pause.stepIndex,
      action,
      ...payload,
    };
    const sent = send(msg);
    if (!sent) {
      // Socket down — fall back to HTTP so the user isn't stranded.
      api.post(`/projects/${current.id}/agents/provide-input`, msg).catch(() => {
        // Worst case: user retries when reconnected. Keep modal open.
        setSubmitting(false);
      });
    }
    // Don't close optimistically — wait for `agent.inputResolved` (covered by
    // the subscriber above). If the resolution event never arrives within
    // ~3s, re-enable the buttons so the user isn't permanently stuck.
    setTimeout(() => setSubmitting(false), 3_000);
  }, [pause, submitting, send, current?.id]);

  if (!pause) return null;

  const isText = pause.inputType === 'text';
  const isConfirm = pause.inputType === 'confirm';
  const isChoice = pause.inputType === 'choice' && Array.isArray(pause.options) && pause.options.length > 0;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-ink-900/45 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pause-modal-title"
    >
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-info-200 overflow-hidden">
        <div className="bg-gradient-to-br from-info-50 via-white to-accent-50 border-b border-info-100 px-6 py-5">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-info-600 text-white flex items-center justify-center shrink-0 shadow-md">
              <Hand className="w-6 h-6" aria-hidden="true" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 id="pause-modal-title" className="font-semibold text-ink-900 text-base truncate">
                  Run paused &mdash; your input is required
                </h2>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${connected ? 'bg-success-100 text-success-700' : 'bg-warn-100 text-warn-700'}`}>
                  {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                  {connected ? 'Live' : 'Reconnecting'}
                </span>
              </div>
              {pause.tcName && (
                <p className="text-xs text-ink-600 mt-1 truncate">
                  Case: <span className="font-medium text-ink-800">{pause.tcName}</span>
                </p>
              )}
              <div className={`mt-2 inline-flex items-center gap-1.5 text-xs font-medium ${lowTime ? 'text-danger-600' : 'text-info-700'}`}>
                <Clock4 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Auto-times out in {remainingLabel}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="rounded-lg border border-ink-200 bg-ink-50 px-4 py-3">
            <div className="flex items-start gap-2 text-sm leading-relaxed text-ink-800">
              <MessageSquareText className="w-4 h-4 text-info-600 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="whitespace-pre-wrap break-words">{pause.prompt}</div>
            </div>
          </div>

          {phase === 'input' && isText && (
            <div>
              <label htmlFor="pause-text-input" className="block text-xs font-medium text-ink-700 mb-1.5">
                Your input
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-ink-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
                <input
                  ref={inputRef}
                  id="pause-text-input"
                  type="text"
                  value={textValue}
                  onChange={(e) => setTextValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && textValue.trim()) submit('continue', { value: textValue });
                  }}
                  className="w-full pl-9 pr-3 py-2 border border-ink-300 rounded-md text-sm focus-visible:outline-none focus-visible:shadow-ring"
                  placeholder="Paste OTP, code, or token here…"
                  autoComplete="off"
                  spellCheck="false"
                  disabled={submitting}
                />
              </div>
            </div>
          )}

          {phase === 'input' && isChoice && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-ink-700">Pick one</p>
              <div className="grid grid-cols-1 gap-1.5">
                {pause.options.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => submit('continue', { value: opt })}
                    disabled={submitting}
                    className="text-left px-3 py-2 rounded-md border border-ink-200 bg-white text-sm text-ink-800 hover:bg-info-50 hover:border-info-400 hover:text-info-700 disabled:opacity-50 transition-colors"
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {phase === 'confirming-block' && (
            <div>
              <label htmlFor="pause-reason" className="block text-xs font-medium text-ink-700 mb-1.5">
                Reason this case is blocked (optional)
              </label>
              <textarea
                id="pause-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 border border-ink-300 rounded-md text-sm focus-visible:outline-none focus-visible:shadow-ring resize-none"
                placeholder="e.g. OTP service unavailable on staging"
                disabled={submitting}
              />
            </div>
          )}
        </div>

        <div className="bg-ink-50 border-t border-ink-200 px-6 py-4">
          {phase === 'input' && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPhase('confirming-block')}
                disabled={submitting}
              >
                <Ban className="w-3.5 h-3.5" aria-hidden="true" />
                Block this case
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => submit('skip')}
                disabled={submitting}
              >
                <SkipForward className="w-3.5 h-3.5" aria-hidden="true" />
                Skip this step
              </Button>
              {!isChoice && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => submit('continue', isText ? { value: textValue } : {})}
                  disabled={submitting || (isText && !textValue.trim())}
                  ref={closeBtnRef}
                >
                  {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                  {isConfirm ? "I've done it — continue" : 'Submit & continue'}
                </Button>
              )}
            </div>
          )}
          {phase === 'confirming-block' && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPhase('input')}
                disabled={submitting}
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => submit('block', { reason: reason.trim() || undefined })}
                disabled={submitting}
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Ban className="w-3.5 h-3.5" aria-hidden="true" />}
                Block this case
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
