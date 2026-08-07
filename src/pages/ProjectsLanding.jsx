import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Grid2X2, List, MoreHorizontal, Plus, Search } from 'lucide-react';
import { useProject } from '../store/project';

function ProjectCard({ project, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(project)}
      className="group flex min-h-[240px] w-full flex-col overflow-hidden rounded-lg border border-ink-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:border-ink-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success-400"
    >
      <div className="flex h-28 items-center justify-center bg-ink-100 text-ink-400">
        <Grid2X2 className="h-9 w-9" aria-hidden="true" />
      </div>
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-success-500/10 text-sm font-semibold text-success-700">
            {(project.name || 'P').slice(0, 2).toUpperCase()}
          </div>
          <span className="rounded-full bg-ink-100 px-2 py-1 text-xs font-medium text-ink-600">
            {project.framework?.includes('playwright') ? 'Web' : project.framework || 'Project'}
          </span>
        </div>
        <div>
          <h2 className="truncate text-lg font-semibold text-ink-950">{project.name}</h2>
          <p className="mt-2 truncate text-sm text-ink-500">{project.targetUrl || 'No target URL configured'}</p>
        </div>
        <div className="mt-auto flex items-center justify-between text-xs text-ink-500">
          <span>{project._count?.testCases || 0} tests</span>
          <MoreHorizontal className="h-4 w-4 opacity-0 transition group-hover:opacity-100" aria-hidden="true" />
        </div>
      </div>
    </button>
  );
}

export default function ProjectsLanding() {
  const { projects, switchTo, loading } = useProject();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [view, setView] = useState('grid');

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((project) => {
      return [project.name, project.targetUrl, project.environment]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [projects, query]);

  const openProject = (project) => {
    switchTo(project.id);
    navigate(`/projects/${project.id}/results`);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-ink-950 text-white">
      <header className="shrink-0 border-b border-white/10 px-page py-4">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Grid2X2 className="h-5 w-5 text-ink-300" aria-hidden="true" />
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight">Projects</h1>
              <p className="text-sm text-ink-400">Choose a workspace to inspect tests, runs, memory, and output.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate('/project-setup')}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-white px-4 text-sm font-semibold text-ink-950 shadow-sm transition hover:bg-ink-100"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New Project
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-page py-8">
        <div className="mx-auto max-w-[1600px]">
          <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <label className="relative block w-full max-w-md">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects..."
                className="h-12 w-full rounded-lg border border-white/10 bg-white/[0.04] pl-11 pr-4 text-sm text-white outline-none transition placeholder:text-ink-500 focus:border-white/25"
              />
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setView('grid')}
                className={`inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/10 ${view === 'grid' ? 'bg-white/10 text-white' : 'text-ink-400 hover:text-white'}`}
                aria-label="Grid view"
              >
                <Grid2X2 className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setView('list')}
                className={`inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/10 ${view === 'list' ? 'bg-white/10 text-white' : 'text-ink-400 hover:text-white'}`}
                aria-label="List view"
              >
                <List className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {loading ? (
            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-6 text-sm text-ink-300">Loading projects...</div>
          ) : visibleProjects.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/15 bg-white/[0.03] p-10 text-center">
              <h2 className="text-lg font-semibold">No projects found</h2>
              <p className="mt-2 text-sm text-ink-400">Create or select a project to start building a workspace.</p>
            </div>
          ) : view === 'grid' ? (
            <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {visibleProjects.map((project) => (
                <ProjectCard key={project.id} project={project} onOpen={openProject} />
              ))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
              {visibleProjects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => openProject(project)}
                  className="flex w-full items-center justify-between gap-4 border-b border-white/10 px-5 py-4 text-left last:border-b-0 hover:bg-white/[0.04]"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-white">{project.name}</div>
                    <div className="truncate text-sm text-ink-400">{project.targetUrl || 'No target URL configured'}</div>
                  </div>
                  <span className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-xs text-ink-300">
                    {project._count?.runs || 0} runs
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
