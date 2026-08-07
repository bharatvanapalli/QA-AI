import React, { useEffect, useState, useCallback } from 'react';
import { Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import api from '../../lib/apiClient';
import { useProject } from '../../store/project';
import { getWorkspaceShortcutRedirect } from '../../lib/projectRoutes';

export default function ProjectWorkspaceShell() {
  const { projectId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { current, projects, switchTo } = useProject();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const shortcutRedirect = getWorkspaceShortcutRedirect(location.pathname);

  useEffect(() => {
    if (shortcutRedirect) return;
    if (!projectId || current?.id === projectId || projects.length === 0) return;
    if (projects.some((project) => project.id === projectId)) switchTo(projectId);
  }, [current?.id, projectId, projects, shortcutRedirect, switchTo]);

  const loadSummary = useCallback(async () => {
    if (shortcutRedirect) {
      setLoading(false);
      return;
    }
    if (!projectId) return;
    setLoading(true);
    try {
      const response = await api.get(`/projects/${projectId}/workspace-summary`);
      setSummary(response.summary || null);
    } catch (err) {
      console.warn('[workspace] summary unavailable', err);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, shortcutRedirect]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  if (shortcutRedirect) {
    return <Navigate to={shortcutRedirect} replace />;
  }

  const project = summary?.project || current || projects.find((item) => item.id === projectId);

  if (!project && !loading) {
    return (
      <div className="flex h-full flex-col overflow-auto bg-ink-50 p-page">
        <div className="rounded-lg border border-ink-200 bg-white p-8">
          <h1 className="text-xl font-semibold text-ink-950">Project not found</h1>
          <p className="mt-2 text-sm text-ink-500">The selected workspace could not be loaded.</p>
          <button
            type="button"
            onClick={() => navigate('/projects')}
            className="mt-5 inline-flex h-10 items-center rounded-md bg-ink-950 px-4 text-sm font-semibold text-white"
          >
            Back to projects
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-ink-50">
      <div className="min-h-0 flex-1 overflow-hidden">
        <Outlet context={{ summary, loading, refreshSummary: loadSummary }} />
      </div>
    </div>
  );
}
