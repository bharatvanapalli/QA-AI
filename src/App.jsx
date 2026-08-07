import React, { useState, useCallback, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { AuthProvider, useAuth } from './store/auth';
import { ProjectProvider, useProject } from './store/project';
import { RunStreamProvider } from './store/runStream';
import { ToastProvider } from './lib/useToast';
import { ConfirmProvider } from './lib/useConfirm';
import Sidebar, { COLLAPSE_KEY } from './components/Sidebar';
import ErrorBoundary from './components/ErrorBoundary';
import LoginScreen from './pages/LoginScreen';
import Profile from './pages/Profile';
import Overview from './pages/Overview';
import AgentRunningIndicator from './components/AgentRunningIndicator';
import PauseModal from './components/PauseModal';
import PausedBanner from './components/PausedBanner';
import ConnectivityBanner from './components/ConnectivityBanner';
import ProjectSetup from './pages/ProjectSetup';
import RunSuite from './pages/RunSuite';
import CompareView from './pages/reports/CompareView';
import SprintCompare from './pages/SprintCompare';
import ProjectWorkspaceShell from './pages/workspace/ProjectWorkspaceShell';
import {
  WorkspaceFiles,
  WorkspaceIntegrations,
  WorkspaceLive,
  WorkspaceMemory,
  WorkspaceOutputFiles,
  WorkspaceRecovery,
  WorkspaceResults,
  WorkspaceTestAccounts,
  WorkspaceTests,
} from './pages/workspace/WorkspaceTabs';

import Settings from './pages/settings/Settings';
import ClaudeSettings from './pages/settings/ClaudeSettings';
import GeminiSettings from './pages/settings/GeminiSettings';
import AiProviderSettings from './pages/settings/AiProviderSettings';
import AdoSettings from './pages/settings/AdoSettings';
import JiraSettings from './pages/settings/JiraSettings';
import WebhookSettings from './pages/settings/WebhookSettings';
import NotificationsSettings from './pages/settings/NotificationsSettings';

// Route-aware error boundary: wraps the page `<Routes>` and resets the
// captured error whenever the user navigates to a different path. Without
// this, a single page crash leaves the "Something broke" fallback stuck
// across the rest of the app until the user hits Reload.
function RouteAwareBoundary({ children }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}

function RequireAuth({ children }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink-50 text-sm text-ink-500">
        Loading session…
      </div>
    );
  }
  if (status === 'guest') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}

function CurrentProjectRedirect({ to }) {
  const { current, loading } = useProject();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink-50 text-sm text-ink-500">
        Loading workspace...
      </div>
    );
  }
  if (!current?.id) return <Navigate to="/project-setup" replace />;
  return <Navigate to={`/projects/${current.id}/${to}`} replace />;
}

function MainLayout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  // Sidebar collapse state persists across sessions via localStorage so power
  // users keep their preferred layout on every visit.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch {}
  }, [collapsed]);
  const toggleCollapse = useCallback(() => setCollapsed((c) => !c), []);

  // Column width matches the sidebar's intrinsic width — 220px expanded,
  // 64px collapsed (room for the 7-wide icon + comfortable side padding).
  const gridCols = collapsed ? 'md:grid-cols-[64px_1fr]' : 'md:grid-cols-[220px_1fr]';

  return (
    // AgentRunningIndicator is `position: fixed` — keep it a sibling of the
    // grid so it never occupies a phantom track on first paint.
    // On md+ the layout is a static two-column grid; below md the sidebar
    // becomes an overlay drawer (handled inside Sidebar) and the main column
    // takes the full width.
    <>
      <AgentRunningIndicator />
      <PauseModal />
      <div className={`md:grid ${gridCols} h-screen w-full overflow-hidden flex flex-col`}>
      <Sidebar
        mobileOpen={mobileNavOpen}
        onCloseMobile={closeMobileNav}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
      />
      <main className="flex flex-col h-screen overflow-hidden bg-ink-50">
        <ConnectivityBanner />
        <PausedBanner />
        {/* Mobile-only top bar with hamburger. Hidden on md+ where the
            sidebar is always visible. Stays above the main scroll area. */}
        <div className="md:hidden flex items-center gap-3 h-12 px-3 border-b border-ink-200 bg-white shrink-0">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="inline-flex items-center justify-center w-9 h-9 rounded-md text-ink-700 hover:bg-ink-100 focus-visible:outline-none focus-visible:shadow-ring"
            aria-label="Open navigation"
            aria-expanded={mobileNavOpen}
            aria-controls="main-navigation"
          >
            <Menu className="w-5 h-5" aria-hidden="true" />
          </button>
          <span className="text-sm font-bold text-ink-900 tracking-tight">QAAI</span>
        </div>
        <RouteAwareBoundary>
          <Routes>
            <Route index element={<Navigate to="/project-setup" replace />} />
            <Route path="projects" element={<Navigate to="/project-setup" replace />} />
            <Route path="projects/:projectId" element={<ProjectWorkspaceShell />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<Overview />} />
              <Route path="run-suite" element={<RunSuite />} />
              <Route path="results" element={<WorkspaceResults />} />
              <Route path="tests" element={<WorkspaceTests />} />
              <Route path="live" element={<WorkspaceLive />} />
              <Route path="output-files" element={<WorkspaceOutputFiles />} />
              <Route path="recovery" element={<WorkspaceRecovery />} />
              <Route path="test-accounts" element={<WorkspaceTestAccounts />} />
              <Route path="files" element={<WorkspaceFiles />} />
              <Route path="memory" element={<WorkspaceMemory />} />
              <Route path="integrations" element={<WorkspaceIntegrations />} />
              <Route path="settings" element={<Navigate to="/project-setup" replace />} />
            </Route>
            <Route path="overview" element={<CurrentProjectRedirect to="overview" />} />
            <Route path="run-suite" element={<CurrentProjectRedirect to="run-suite" />} />
            <Route path="test-cases" element={<CurrentProjectRedirect to="tests" />} />
            <Route path="live-pipeline" element={<CurrentProjectRedirect to="live" />} />
            {/* Back-compat — old /theater bookmarks still work */}
            <Route path="theater" element={<CurrentProjectRedirect to="live" />} />
            <Route path="project-setup" element={<ProjectSetup />} />
            {/* Execution Log was removed in May 2026 — Live Pipeline +
                Reports cover its job. Redirect any lingering bookmarks
                rather than 404'ing them. */}
            <Route path="execution-log" element={<CurrentProjectRedirect to="live" />} />
            <Route path="reports" element={<CurrentProjectRedirect to="results" />} />
            <Route path="reports/compare" element={<CompareView />} />
            <Route path="sprints/compare" element={<SprintCompare />} />
            <Route path="blocked-items" element={<CurrentProjectRedirect to="recovery" />} />
            {/* Governance page removed June 2026 — the AI's MCP-derived
                locators are the trust surface, so the human-review/merge
                workflow was overhead. Generated specs now land directly
                in Output Files. Old /governance bookmarks redirect. */}
            <Route path="governance" element={<CurrentProjectRedirect to="output-files" />} />
            <Route path="knowledge-base" element={<CurrentProjectRedirect to="memory" />} />
            <Route path="output-files" element={<CurrentProjectRedirect to="output-files" />} />

            <Route path="settings" element={<Settings />}>
              <Route index element={<Navigate to="ai-provider" replace />} />
              <Route path="ai-provider" element={<AiProviderSettings />} />
              <Route path="claude" element={<ClaudeSettings />} />
              <Route path="gemini" element={<GeminiSettings />} />
              <Route path="ado" element={<AdoSettings />} />
              <Route path="jira" element={<JiraSettings />} />
              <Route path="webhook" element={<WebhookSettings />} />
              <Route path="notifications" element={<NotificationsSettings />} />
            </Route>

            <Route path="profile" element={<Profile />} />
            <Route path="*" element={<Navigate to="/project-setup" replace />} />
          </Routes>
        </RouteAwareBoundary>
      </main>
      </div>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <ProjectProvider>
              <RunStreamProvider>
                <Routes>
                  <Route path="/login" element={<LoginScreen />} />
                  <Route
                    path="/*"
                    element={
                      <RequireAuth>
                        <MainLayout />
                      </RequireAuth>
                    }
                  />
                </Routes>
              </RunStreamProvider>
            </ProjectProvider>
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
