import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Flag, Calendar, Archive, PlayCircle, Pencil } from 'lucide-react';
import { useProject } from '../store/project';

/**
 * Sprint switcher pill (Phase B / B3). Sits next to ProjectPicker in
 * PageHeader. Renders only when the current project has ≥1 sprint;
 * otherwise the header stays uncluttered.
 *
 * Opens a small listbox with every sprint for the project plus a "No sprint
 * (all data)" option that clears the filter (returns to project-wide view).
 * Archived sprints render as read-only chips on selection so users can't
 * accidentally write to them — write-gating is enforced server-side
 * (SPRINT_LOCKED) regardless.
 */
const LIFECYCLE_META = {
  planning:    { label: 'Planning',   icon: Pencil,     cls: 'bg-ink-100 text-ink-700 border-ink-200' },
  in_progress: { label: 'In progress',icon: PlayCircle, cls: 'bg-info-50 text-info-700 border-info-100' },
  completed:   { label: 'Completed',  icon: Check,      cls: 'bg-success-50 text-success-700 border-success-200' },
  archived:    { label: 'Archived',   icon: Archive,    cls: 'bg-ink-100 text-ink-500 border-ink-200' },
};
function lifecycleMeta(l) { return LIFECYCLE_META[l] || LIFECYCLE_META.in_progress; }

export default function SprintPicker() {
  const { sprints, currentSprint, switchSprint } = useProject();
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null);
  const btnRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (!btnRef.current?.contains(e.target) && !listRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
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
      const width = 320;
      setMenuRect({
        top: Math.min(window.innerHeight - 96, rect.bottom + 8),
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        width,
        maxHeight: Math.max(180, window.innerHeight - rect.bottom - 24),
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

  if (!sprints?.length) return null;

  const label = currentSprint ? currentSprint.name : 'All sprints';
  const lifecycle = currentSprint ? lifecycleMeta(currentSprint.lifecycle) : null;

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`h-9 px-3 inline-flex items-center gap-2 rounded-pill border bg-white text-xs font-semibold ${
          currentSprint ? 'border-info-200 text-info-700' : 'border-ink-200 text-ink-700'
        } hover:bg-ink-50 transition-colors`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch sprint"
      >
        <Calendar className="w-3.5 h-3.5" aria-hidden="true" />
        <span className="max-w-[160px] truncate">{label}</span>
        {lifecycle && (
          <span className={`hidden md:inline-flex items-center px-1.5 py-0.5 rounded-pill text-2xs font-bold uppercase tracking-wider border ${lifecycle.cls}`}>
            {lifecycle.label}
          </span>
        )}
        <ChevronDown className="w-3.5 h-3.5 text-ink-400" aria-hidden="true" />
      </button>

      {open && menuRect && createPortal(
        <div
          ref={listRef}
          role="listbox"
          className="fixed z-[1000] overflow-y-auto rounded-lg border border-ink-200 bg-white shadow-pop"
          style={{ top: menuRect.top, left: menuRect.left, width: menuRect.width, maxHeight: menuRect.maxHeight }}
        >
          <button
            type="button"
            onClick={() => { switchSprint(null); setOpen(false); }}
            role="option"
            aria-selected={!currentSprint}
            className={`w-full text-left px-3 py-2 border-b border-ink-100 hover:bg-ink-50 inline-flex items-center gap-2 ${
              !currentSprint ? 'bg-ink-50' : ''
            }`}
          >
            <Flag className="w-3.5 h-3.5 text-ink-500" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-ink-900">All sprints</div>
              <div className="text-2xs text-ink-500">Show project-wide data (legacy view)</div>
            </div>
            {!currentSprint && <Check className="w-3.5 h-3.5 text-ink-700" aria-hidden="true" />}
          </button>

          {sprints.map((s) => {
            const m = lifecycleMeta(s.lifecycle);
            const Icon = m.icon;
            const selected = s.id === currentSprint?.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => { switchSprint(s.id); setOpen(false); }}
                role="option"
                aria-selected={selected}
                className={`w-full text-left px-3 py-2 border-b border-ink-100 last:border-b-0 hover:bg-ink-50 ${
                  selected ? 'bg-ink-50' : ''
                }`}
              >
                <div className="flex items-start gap-2">
                  <Icon className="w-3.5 h-3.5 mt-0.5 text-ink-500" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-ink-900 truncate">{s.name}</span>
                      <span className={`px-1.5 py-0.5 rounded-pill text-2xs font-bold uppercase tracking-wider border ${m.cls}`}>
                        {m.label}
                      </span>
                    </div>
                    <div className="text-2xs text-ink-500 mt-0.5 truncate">
                      {(s.counts?.runs ?? 0)} runs · {(s.counts?.requirements ?? 0)} reqs · {(s.counts?.documents ?? 0)} docs · {(s.counts?.blockers ?? 0)} blocked
                    </div>
                  </div>
                  {selected && <Check className="w-3.5 h-3.5 text-ink-700 shrink-0 mt-1" aria-hidden="true" />}
                </div>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
