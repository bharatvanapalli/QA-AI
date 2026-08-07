import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  X, Sparkles, Loader2, ShieldCheck, Database, ListChecks, SplitSquareHorizontal,
  SlidersHorizontal, LockKeyhole, Target, Wand2,
} from 'lucide-react';
import Button from './ui/Button';

const QUICK_INTENTS = [
  { id: 'negative', label: 'Negative paths', icon: ShieldCheck },
  { id: 'boundary', label: 'Boundary values', icon: SlidersHorizontal },
  { id: 'security', label: 'Security', icon: LockKeyhole },
  { id: 'data_driven', label: 'Use test data', icon: Database },
  { id: 'strict_assertions', label: 'Stricter assertions', icon: ListChecks },
  { id: 'split_cases', label: 'Split cases', icon: SplitSquareHorizontal },
  { id: 'skip_cosmetic', label: 'Skip cosmetic', icon: Target },
  { id: 'roles', label: 'Roles/RBAC', icon: Wand2 },
];

export default function GenerationGuidancePanel({
  open,
  title = 'Tell QAAI what to improve',
  subtitle = 'Add QA direction. QAAI will apply it through the generation contracts instead of treating it as loose chat.',
  placeholder = 'Example: Add price-range validation using uploaded data, keep each data row as an independent test case, and avoid cosmetic text checks.',
  submitLabel = 'Apply guidance',
  loading = false,
  subject = null,
  onClose,
  onSubmit,
}) {
  const [instruction, setInstruction] = useState('');
  const [selected, setSelected] = useState(() => new Set());

  useEffect(() => {
    if (!open) return;
    setInstruction('');
    setSelected(new Set());
  }, [open]);

  const canSubmit = useMemo(
    () => instruction.trim().length > 0 || selected.size > 0,
    [instruction, selected],
  );

  const toggle = (id) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = () => {
    if (!canSubmit || loading) return;
    onSubmit?.({
      instruction: instruction.trim(),
      quickIntents: Array.from(selected),
    });
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.button
            type="button"
            aria-label="Close guidance panel"
            className="absolute inset-0 bg-ink-900/24 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ x: 420, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 420, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 top-0 h-full w-full max-w-[440px] bg-white shadow-[0_24px_80px_-20px_rgba(15,23,42,0.35)] border-l border-ink-200 flex flex-col"
          >
            <div className="px-5 py-4 border-b border-ink-200 bg-gradient-to-br from-white to-accent-50/50">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-accent-100 border border-accent-200 inline-flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4 text-accent-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-base font-bold text-ink-900 tracking-tight">{title}</h2>
                  <p className="text-xs text-ink-600 mt-1 leading-relaxed">{subtitle}</p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="w-8 h-8 rounded-pill inline-flex items-center justify-center text-ink-500 hover:bg-white hover:text-ink-900 transition-colors"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {subject && (
                <div className="mt-3 rounded-xl border border-white/70 bg-white/70 px-3 py-2 text-xs text-ink-700">
                  <span className="font-semibold text-ink-900">Scope: </span>
                  {subject}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              <div>
                <div className="text-2xs uppercase tracking-[0.16em] font-bold text-ink-500 mb-2">
                  Quick direction
                </div>
                <div className="flex flex-wrap gap-2">
                  {QUICK_INTENTS.map(({ id, label, icon: Icon }) => {
                    const active = selected.has(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => toggle(id)}
                        aria-pressed={active}
                        className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-pill text-xs font-semibold border transition-colors ${
                          active
                            ? 'bg-ink-900 text-white border-ink-900'
                            : 'bg-white text-ink-700 border-ink-200 hover:border-accent-300 hover:text-accent-700'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="text-2xs uppercase tracking-[0.16em] font-bold text-ink-500 block mb-2">
                  Specific instruction
                </label>
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  rows={8}
                  maxLength={4000}
                  placeholder={placeholder}
                  className="w-full resize-none rounded-2xl border border-ink-200 bg-ink-50/50 px-3 py-3 text-sm text-ink-900 placeholder:text-ink-400 focus-visible:outline-none focus-visible:shadow-ring"
                />
                <div className="mt-1 text-right text-2xs text-ink-400 tabular-nums">
                  {instruction.length}/4000
                </div>
              </div>

              <div className="rounded-2xl border border-info-200 bg-info-50/60 px-3 py-3 text-xs text-info-900 leading-relaxed">
                QAAI will still enforce requirement traceability, test-data binding, declared assertion fidelity, and runnable step structure. Guidance can focus generation, but it cannot override verified source truth.
              </div>
            </div>

            <div className="px-5 py-4 border-t border-ink-200 bg-white flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
                Cancel
              </Button>
              <Button size="sm" onClick={submit} loading={loading} disabled={!canSubmit || loading}>
                {!loading && <Sparkles className="w-3.5 h-3.5" />}
                {loading ? 'Applying...' : submitLabel}
              </Button>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
