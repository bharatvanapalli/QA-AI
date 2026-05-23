import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../store/project';
import { ChevronDown, Folder, FolderPlus, Search, Check } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * Searchable project picker (replaces the native <select>). For users with
 * >10 projects the previous unsearchable dropdown became painful — this
 * supports typing to filter, arrow-key navigation, and Enter to select.
 *
 * a11y: button has aria-haspopup + aria-expanded. Open listbox is
 * role="listbox" with role="option" children and aria-selected/aria-activedescendant.
 */
export default function ProjectPicker() {
  const { projects, current, switchTo, loading } = useProject();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const btnRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return projects;
    const q = query.trim().toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, query]);

  // Close on outside click + Escape; reset query when closing.
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (
        !btnRef.current?.contains(e.target) &&
        !listRef.current?.contains(e.target)
      ) {
        setOpen(false);
        setQuery('');
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setQuery('');
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Focus the search input when opening and reset highlight.
  useEffect(() => {
    if (open) {
      setActiveIdx(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Keep activeIdx in range when the filter changes.
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, activeIdx]);

  const choose = useCallback((p) => {
    if (!p) return;
    switchTo(p.id);
    setOpen(false);
    setQuery('');
    btnRef.current?.focus();
  }, [switchTo]);

  const onInputKey = useCallback((e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(filtered[activeIdx]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIdx(Math.max(0, filtered.length - 1));
    }
  }, [filtered, activeIdx, choose]);

  if (loading) {
    return (
      <div className="inline-flex items-center gap-2 h-9 px-3 rounded-md bg-ink-50 border border-ink-200 text-xs text-ink-500">
        <span className="w-1.5 h-1.5 rounded-full bg-ink-300 animate-pulse" />
        Loading projects…
      </div>
    );
  }

  if (!projects.length) {
    return (
      <Link
        to="/project-setup"
        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-white border border-ink-200 text-xs font-semibold text-ink-700 hover:bg-ink-50 hover:border-ink-300 transition-colors shadow-card"
      >
        <FolderPlus className="w-3.5 h-3.5" />
        Create first project
      </Link>
    );
  }

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Active project"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-2 h-9 pl-3 pr-2 rounded-md bg-white border border-ink-200 shadow-card text-xs font-semibold text-ink-800 hover:bg-ink-50 hover:border-ink-300 focus:outline-none focus:border-ink-900 focus:shadow-ring transition-all max-w-[240px]"
      >
        <Folder className="w-3.5 h-3.5 text-ink-400 shrink-0" aria-hidden="true" />
        <span className="truncate">{current?.name || 'Select project'}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-ink-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={listRef}
          className="absolute z-40 top-full mt-1 left-0 w-[280px] bg-white border border-ink-200 rounded-md shadow-pop overflow-hidden"
          role="presentation"
        >
          <div className="relative border-b border-ink-100">
            <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-ink-400 pointer-events-none" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="Search projects…"
              className="w-full pl-8 pr-3 h-9 bg-transparent text-sm placeholder:text-ink-400 focus:outline-none"
              aria-autocomplete="list"
              aria-controls="project-picker-list"
              aria-activedescendant={filtered[activeIdx] ? `pp-opt-${filtered[activeIdx].id}` : undefined}
            />
          </div>
          <ul
            id="project-picker-list"
            role="listbox"
            aria-label="Projects"
            className="max-h-72 overflow-y-auto py-1"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-3 text-xs text-ink-500" role="presentation">
                No projects match "{query}".
              </li>
            ) : filtered.map((p, i) => {
              const isActive = i === activeIdx;
              const isSelected = current?.id === p.id;
              return (
                <li
                  key={p.id}
                  id={`pp-opt-${p.id}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => choose(p)}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={`px-3 py-2 text-sm cursor-pointer flex items-center gap-2 ${
                    isActive ? 'bg-ink-50' : ''
                  } ${isSelected ? 'font-semibold text-ink-900' : 'text-ink-700'}`}
                >
                  <Folder className="w-3.5 h-3.5 text-ink-400 shrink-0" aria-hidden="true" />
                  <span className="flex-1 truncate">{p.name}</span>
                  {isSelected && <Check className="w-3.5 h-3.5 text-success-600 shrink-0" aria-hidden="true" />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
