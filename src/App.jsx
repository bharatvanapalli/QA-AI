import React, { useState, useCallback, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { AuthProvider, useAuth } from './store/auth';
import { ProjectProvider } from './store/project';
import { RunStreamProvider } from './store/runStream';
import { ToastProvider } from './lib/useToast';
import { ConfirmProvider } from './lib/useConfirm';
import Sidebar, { COLLAPSE_KEY } from './components/Sidebar';
import ErrorBoundary from './components/ErrorBoundary';
import LoginScreen from './pages/LoginScreen';
import Profile from './pages/Profile';
import Overview from './pages/Overview';
import RunSuite from './pages/RunSuite';
import TestCases from './pages/TestCases';
import Theater from './pages/Theater';
import AgentRunningIndicator from './components/AgentRunningIndicator';
import ProjectSetup from './pages/ProjectSetup';
import ExecutionLog from './pages/ExecutionLog';
import Reports from './pages/Reports';
import CompareView from './pages/reports/CompareView';
import SprintCompare from './pages/SprintCompare';
import BlockedItems from './pages/BlockedItems';
import Governance from './pages/Governance';
import KnowledgeBase from './pages/KnowledgeBase';
import OutputFiles from './pages/OutputFiles';

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
      <div className={`md:grid ${gridCols} h-screen w-full overflow-hidden flex flex-col`}>
      <Sidebar
        mobileOpen={mobileNavOpen}
        onCloseMobile={closeMobileNav}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
      />
      <main className="flex flex-col h-screen overflow-hidden bg-ink-50">
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
            <Route index element={<Navigate to="/overview" replace />} />
            <Route path="overview" element={<Overview />} />
            <Route path="run-suite" element={<RunSuite />} />
            <Route path="test-cases" element={<TestCases />} />
            <Route path="live-pipeline" element={<Theater />} />
            {/* Back-compat — old /theater bookmarks still work */}
            <Route path="theater" element={<Navigate to="/live-pipeline" replace />} />
            <Route path="project-setup" element={<ProjectSetup />} />
            <Route path="execution-log" element={<ExecutionLog />} />
            <Route path="reports" element={<Reports />} />
            <Route path="reports/compare" element={<CompareView />} />
            <Route path="sprints/compare" element={<SprintCompare />} />
            <Route path="blocked-items" element={<BlockedItems />} />
            <Route path="governance" element={<Governance />} />
            <Route path="knowledge-base" element={<KnowledgeBase />} />
            <Route path="output-files" element={<OutputFiles />} />

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
            <Route path="*" element={<Navigate to="/overview" replace />} />
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
