import React from 'react';
import ProjectPicker from './ProjectPicker';
import SprintPicker from './SprintPicker';
import BudgetChip from './BudgetChip';

export default function PageHeader({ title, subtitle, showProject = true, children }) {
  return (
    <header className="bg-white border-b border-ink-200 px-page py-5 flex items-center justify-between gap-6 sticky top-0 z-20">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-ink-900 tracking-tight truncate">{title}</h1>
        {subtitle && <p className="text-sm text-ink-500 truncate mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <BudgetChip />
        {showProject && <ProjectPicker />}
        {showProject && <SprintPicker />}
        {children}
      </div>
    </header>
  );
}
