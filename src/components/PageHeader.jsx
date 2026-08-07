import React from 'react';
import { useLocation } from 'react-router-dom';
import ProjectPicker from './ProjectPicker';
import SprintPicker from './SprintPicker';
import GenerationPicker from './GenerationPicker';
import BudgetChip from './BudgetChip';

export default function PageHeader({ title, subtitle, showProject = true, children }) {
  const location = useLocation();
  const inWorkspace = /^\/projects\/[^/]+/.test(location.pathname);

  if (inWorkspace) {
    return (
      <section className="border-b border-ink-200 bg-white px-page py-3">
        <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
            <BudgetChip />
            {showProject && <ProjectPicker />}
            {showProject && <SprintPicker />}
            {showProject && <GenerationPicker />}
            {children}
          </div>
        </div>
      </section>
    );
  }

  return (
    <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/95 px-page py-3 shadow-[0_1px_0_rgba(15,23,42,0.02)] backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-ink-900">{title}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
            <BudgetChip />
            {showProject && <ProjectPicker />}
            {showProject && <SprintPicker />}
            {showProject && <GenerationPicker />}
          </div>
        </div>

        {children && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 xl:justify-end">
            {children}
          </div>
        )}
      </div>
    </header>
  );
}
