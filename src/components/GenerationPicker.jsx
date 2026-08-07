import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, GitBranch, History, Star } from 'lucide-react';
import { useProject } from '../store/project';

function fmtDate(value) {
  if (!value) return 'No date';
  try {
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (_) {
    return 'No date';
  }
}

function generationName(generation) {
  if (!generation) return 'No generation selected';
  return `v${generation.version}${generation.label ? ` - ${generation.label}` : ''}`;
}

export default function GenerationPicker({
  label = 'Past generated scenarios',
  className = '',
  buttonClassName = '',
}) {
  const { generations, currentGeneration, switchGeneration } = useProject();
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null);
  const btnRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (event) => {
      if (!btnRef.current?.contains(event.target) && !listRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const updateRect = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(420, window.innerWidth - 24);
      setMenuRect({
        top: Math.min(window.innerHeight - 96, rect.bottom + 10),
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        width,
        maxHeight: Math.max(220, window.innerHeight - rect.bottom - 24),
      });
    };
    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [open]);

  if (!generations || generations.length < 1) return null;

  const active = currentGeneration || generations.find((generation) => generation.isCurrent) || generations[0];
  const viewingPast = active && !active.isCurrent;
  const sortedGenerations = [...generations].sort((a, b) => Number(b.version || 0) - Number(a.version || 0));

  return (
    <div className={`relative ${className}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`group inline-flex h-10 max-w-full items-center gap-2 rounded-pill border bg-white/78 px-3 text-sm font-semibold text-ink-800 shadow-sm backdrop-blur-sm transition-all hover:-translate-y-px hover:border-accent-300 hover:bg-white hover:shadow-card focus-visible:outline-none focus-visible:shadow-ring ${
          viewingPast ? 'border-warn-300/80 text-warn-800' : 'border-ink-200/70'
        } ${buttonClassName}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch the whole workspace to a previous scenario generation"
      >
        <History className={`h-4 w-4 ${viewingPast ? 'text-warn-600' : 'text-accent-600'}`} aria-hidden="true" />
        <span className="truncate">{label}</span>
        <span className="hidden max-w-[130px] truncate rounded-pill bg-ink-50 px-2 py-0.5 text-2xs font-bold text-ink-600 sm:inline">
          {generationName(active)}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && menuRect && createPortal(
        <div
          ref={listRef}
          role="listbox"
          className="fixed z-[1000] overflow-hidden rounded-2xl border border-white/70 bg-white/92 shadow-[0_28px_70px_-24px_rgba(15,23,42,0.32)] backdrop-blur-xl"
          style={{ top: menuRect.top, left: menuRect.left, width: menuRect.width, maxHeight: menuRect.maxHeight }}
        >
          <div className="border-b border-ink-100/80 bg-gradient-to-br from-white via-info-50/45 to-accent-50/45 px-4 py-3">
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-ink-500">
              <GitBranch className="h-3.5 w-3.5 text-accent-600" aria-hidden="true" />
              Past generated scenarios
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              Selecting a version updates Tests, Overview, Reports, and Output Files together.
            </p>
          </div>

          <div className="max-h-[inherit] overflow-y-auto py-1">
            {sortedGenerations.map((generation) => {
              const selected = generation.id === active?.id;
              const isCurrent = !!generation.isCurrent;
              return (
                <button
                  key={generation.id}
                  type="button"
                  onClick={() => {
                    switchGeneration(generation.id);
                    setOpen(false);
                  }}
                  role="option"
                  aria-selected={selected}
                  className={`w-full border-b border-ink-100/70 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-info-50/60 ${
                    selected ? 'bg-accent-50/55' : 'bg-transparent'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
                      isCurrent
                        ? 'border-accent-200 bg-accent-50 text-accent-700'
                        : 'border-ink-200 bg-white text-ink-500'
                    }`}>
                      {isCurrent ? <Star className="h-3.5 w-3.5" aria-hidden="true" /> : <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-bold text-ink-950">{generationName(generation)}</span>
                        <span className={`rounded-pill border px-2 py-0.5 text-2xs font-black uppercase tracking-wider ${
                          isCurrent
                            ? 'border-accent-200 bg-accent-50 text-accent-700'
                            : 'border-ink-200 bg-white/80 text-ink-500'
                        }`}>
                          {isCurrent ? 'Current' : 'History'}
                        </span>
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                        <span>{fmtDate(generation.createdAt)}</span>
                        <span aria-hidden="true">.</span>
                        <span>{generation.scenarioCount ?? 0} scenarios</span>
                        <span aria-hidden="true">.</span>
                        <span>{generation.caseCount ?? 0} cases</span>
                      </span>
                    </span>
                    {selected && <Check className="mt-2 h-4 w-4 shrink-0 text-accent-700" aria-hidden="true" />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
