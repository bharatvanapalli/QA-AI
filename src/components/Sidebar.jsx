import React, { memo, useEffect, useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  PlayCircle,
  FileText,
  BarChart3,
  AlertCircle,
  Database,
  Brain,
  Files,
  Bot,
  Settings as SettingsIcon,
  User,
  LogOut,
  Sparkles,
  X,
  ChevronsLeft,
  ChevronsRight,
  Cpu,
} from 'lucide-react';
import { useAuth } from '../store/auth';
import { useRunStream } from '../store/runStream';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import api from '../lib/apiClient';
import { buildProjectWorkspacePath } from '../lib/projectRoutes';

const PRIMARY = [
  { to: '/overview', label: 'Overview', icon: LayoutDashboard },
  { to: '/run-suite', label: 'Run Suite', icon: PlayCircle },
  { to: '/test-cases', label: 'Test Cases', icon: FileText },
  { to: '/live-pipeline', label: 'Live Pipeline', icon: Bot, liveBadge: true },
  { to: '/project-setup', label: 'Project Setup', icon: Database },
];

const RESULTS = [
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/blocked-items', label: 'Recovery', icon: AlertCircle },
];

const KNOWLEDGE = [
  { to: '/knowledge-base', label: 'Knowledge Base', icon: Brain },
  { to: '/output-files', label: 'Output Files', icon: Files },
];

function SectionLabel({ children, id, collapsed }) {
  if (collapsed) {
    return (
      <li
        id={id}
        role="presentation"
        aria-hidden="true"
        className="mx-3 mt-5 mb-2 border-t border-white/10"
      />
    );
  }
  return (
    <li
      id={id}
      role="presentation"
      className="px-3 pt-5 pb-2 text-2xs uppercase tracking-[0.18em] font-semibold text-ink-400"
    >
      {children}
    </li>
  );
}

// NavItem is memoised so re-renders in the layout above don't cascade into
// every nav row — each row only re-renders when its own props change. The
// `onNavigate` callback (used by the mobile drawer to auto-close after a
// click) is expected to be referentially stable from the parent.
const NavItem = memo(function NavItem({
  to,
  label,
  icon: Icon,
  liveBadge,
  showBadge,
  onNavigate,
  collapsed,
  end,
}) {
  return (
    <li>
      <NavLink
        to={to}
        end={end}
        onClick={onNavigate}
        title={collapsed ? label : undefined}
        // NavLink already sets aria-current="page" when the route matches, so
        // screen readers announce the active item. We also expose a clean
        // focus-visible ring for keyboard users. The relative positioning
        // anchors the collapsed-mode live indicator dot.
        className={({ isActive }) =>
          `relative flex items-center ${collapsed ? 'justify-center px-0' : 'gap-2.5 px-3'} py-2 rounded-md text-sm font-medium transition-all duration-150 ease-out-soft mx-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success-400/70
            ${isActive
              ? 'bg-white/10 text-white shadow-[inset_2px_0_0_0_rgb(16,185,129)]'
              : 'text-ink-300 hover:bg-white/5 hover:text-white'}`
        }
      >
        <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
        {!collapsed && <span className="truncate flex-1">{label}</span>}
        {!collapsed && liveBadge && showBadge && (
          <span
            className="text-2xs uppercase tracking-wider font-bold text-success-300 bg-success-500/15 px-1.5 py-0.5 rounded animate-pulse"
            aria-label="Run in progress"
          >
            live
          </span>
        )}
        {collapsed && liveBadge && showBadge && (
          <span
            className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-success-400 animate-pulse"
            aria-label="Run in progress"
          />
        )}
      </NavLink>
    </li>
  );
});

const COLLAPSE_KEY = 'qaai.sidebar.collapsed';

/**
 * Sidebar component.
 *
 * `mobileOpen` and `onCloseMobile` are optional — when present they enable
 * the drawer behaviour on narrow viewports (MainLayout wires them up). The
 * sidebar stays in its static column layout at `≥ md` widths regardless.
 *
 * `collapsed` and `onToggleCollapse` drive the desktop icon-only mode; both
 * are provided by MainLayout so the outer grid column width can match.
 */
function Sidebar({
  mobileOpen = false,
  onCloseMobile,
  collapsed = false,
  onToggleCollapse,
}) {
  const { profile, logout, status } = useAuth();
  const { running, liveActive } = useRunStream();
  const { current } = useProject();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const providerStatus = useProviderStatus(status, current?.aiProvider, location.pathname);
  const projectPath = (tab) => buildProjectWorkspacePath(current?.id, tab);
  const primaryItems = [
    { to: projectPath('overview'), label: 'Overview', icon: LayoutDashboard },
    { to: projectPath('run-suite'), label: 'Run Suite', icon: PlayCircle },
    { to: projectPath('tests'), label: 'Tests', icon: FileText },
    { to: projectPath('live'), label: 'Live Pipeline', icon: Bot, liveBadge: true },
  ];
  const outputItems = [
    { to: projectPath('results'), label: 'Reports', icon: BarChart3 },
    { to: projectPath('output-files'), label: 'Output Files', icon: Files },
    { to: projectPath('recovery'), label: 'Recovery', icon: AlertCircle },
    { to: projectPath('memory'), label: 'Memory', icon: Brain },
  ];

  const handleLogout = async () => {
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch (err) {
      // Don't strand the user on the sidebar with a stale session — surface
      // the failure so they know to retry, instead of silently navigating to
      // /login while the cookie is still valid (a real risk on shared
      // machines).
      toast.error(err?.message || 'Sign-out failed. Please retry.', {
        title: 'Sign-out failed',
      });
    }
  };

  // Auto-close the drawer on route change so a NavLink click on mobile
  // doesn't leave the menu sitting on top of the new page.
  useEffect(() => {
    if (mobileOpen && onCloseMobile) onCloseMobile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Escape closes the drawer. Listener is only attached while open so it
  // doesn't shadow other ESC consumers on desktop.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') onCloseMobile?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onCloseMobile]);

  return (
    <>
      {/* Mobile-only scrim — visible only when drawer open. Click closes. */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        role="navigation"
        aria-label="Main navigation"
        className={`bg-ink-900 text-ink-100 flex flex-col h-screen border-r border-black/30
          fixed inset-y-0 left-0 w-64 z-50
          md:static md:w-auto md:translate-x-0 md:z-auto
          ${mobileOpen ? 'translate-x-0 sidebar-drawer-enter' : '-translate-x-full md:translate-x-0'}
        `}
      >
        {/* Brand */}
        <div className={`${collapsed ? 'px-2 justify-center' : 'px-4'} py-5 flex items-center gap-2 border-b border-white/5`}>
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-success-400 to-success-600 flex items-center justify-center shadow-pop shrink-0">
            <Sparkles className="w-4 h-4 text-white" aria-hidden="true" />
          </div>
          {!collapsed && (
            <div className="flex flex-col leading-tight flex-1 min-w-0">
              <span className="font-bold text-white text-base tracking-tight">QAAI</span>
              <span className="text-2xs text-ink-400 uppercase tracking-widest font-medium">Quality Intelligence</span>
            </div>
          )}
          {mobileOpen && (
            <button
              type="button"
              onClick={onCloseMobile}
              className="md:hidden w-8 h-8 rounded-md text-ink-300 hover:bg-white/10 hover:text-white flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success-400/70"
              aria-label="Close navigation"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Nav — proper <ul> so screen readers announce "list, N items". */}
        <nav className="flex-1 overflow-y-auto py-3" aria-label="Primary">
          <ul className="list-none m-0 p-0">
            {primaryItems.map((i) => (
              <NavItem key={i.to} {...i} showBadge={liveActive ?? running} collapsed={collapsed} />
            ))}

            <SectionLabel id="sidebar-output" collapsed={collapsed}>Output</SectionLabel>
            {outputItems.map((i) => <NavItem key={i.to} {...i} collapsed={collapsed} />)}

            <SectionLabel id="sidebar-config" collapsed={collapsed}>Configuration</SectionLabel>
            <NavItem to="/project-setup" label="Projects" icon={Database} collapsed={collapsed} />
            <NavItem to="/settings" label="Settings" icon={SettingsIcon} collapsed={collapsed} />
            <ProviderStatusRow status={providerStatus} collapsed={collapsed} />
            <NavItem to="/profile" label="Profile" icon={User} collapsed={collapsed} />
          </ul>
        </nav>

        {/* Profile footer */}
        <div className="border-t border-white/5 p-3">
          <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2.5'} px-2 py-2 rounded-md hover:bg-white/5 transition-colors mb-1`}>
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-accent-400 to-accent-600 flex items-center justify-center text-xs font-bold text-white shadow-sm shrink-0" aria-hidden="true">
              {(profile?.firstName?.[0] || profile?.email?.[0] || '?').toUpperCase()}
            </div>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-white truncate leading-tight">
                  {profile?.firstName ? `${profile.firstName} ${profile.lastName || ''}` : profile?.email}
                </div>
                <div className="text-2xs text-ink-400 truncate uppercase tracking-wider font-medium">
                  {profile?.role || 'user'}
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleLogout}
            title={collapsed ? 'Sign out' : undefined}
            className="w-full flex items-center justify-center gap-1.5 h-8 rounded-md text-xs font-medium text-ink-300 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success-400/70 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
            {!collapsed && 'Sign out'}
          </button>

          {/* Desktop-only collapse toggle. Hidden below md (drawer uses X close). */}
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              className="hidden md:flex w-full items-center justify-center gap-1.5 h-7 mt-1 rounded-md text-2xs uppercase tracking-wider font-semibold text-ink-400 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success-400/70 transition-colors"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-pressed={collapsed}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed
                ? <ChevronsRight className="w-3.5 h-3.5" aria-hidden="true" />
                : (<>
                    <ChevronsLeft className="w-3.5 h-3.5" aria-hidden="true" />
                    Collapse
                  </>)
              }
            </button>
          )}
        </div>
      </aside>
    </>
  );
}

// ── useProviderStatus ──────────────────────────────────────────────
// Polls the configured-status of the active project's AI provider so the
// sidebar can surface "Claude OK" / "Gemini missing key" without forcing
// the user to navigate to Settings to find out. Re-fetches when:
//   · the user authenticates,
//   · the active provider changes,
//   · the user leaves a /settings/* route (in case they just saved/deleted).
// Cheap — one GET per transition, payload is tiny.
function useProviderStatus(authStatus, aiProvider, pathname) {
  const [state, setState] = useState({ loading: true, info: null, provider: null });
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Track the previous pathname so we re-fetch on exit-from-settings.
  const wasInSettings = pathname.startsWith('/settings');
  useEffect(() => {
    const onChanged = (event) => {
      const provider = event && event.detail && event.detail.provider;
      if (!provider || provider === aiProvider) setRefreshNonce((n) => n + 1);
    };
    window.addEventListener('qaai:provider-settings-changed', onChanged);
    return () => window.removeEventListener('qaai:provider-settings-changed', onChanged);
  }, [aiProvider]);
  useEffect(() => {
    if (authStatus !== 'authed' || !aiProvider) {
      setState({ loading: false, info: null, provider: aiProvider || null });
      return;
    }
    let cancelled = false;
    (async () => {
      setState((s) => ({ ...s, loading: true, provider: aiProvider }));
      try {
        const res = await api.get(`/settings/${aiProvider}`);
        if (!cancelled) {
          setState({ loading: false, info: res, provider: aiProvider });
        }
      } catch {
        if (!cancelled) {
          setState({ loading: false, info: null, provider: aiProvider });
        }
      }
    })();
    return () => { cancelled = true; };
    // pathname dep lets us refetch when user leaves a /settings/* route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, aiProvider, wasInSettings, refreshNonce]);
  return state;
}

// ── ProviderStatusRow ──────────────────────────────────────────────
// Compact provider-state line below the Settings nav item. Three states:
//   · valid       → success-tinted "Claude · OK" (or "Gemini · OK")
//   · unconfigured→ warn-tinted, links to Settings for the active provider
//   · invalid     → danger-tinted, links to Settings with same affordance
// Hidden when no project is active (nothing to bind status to).
function ProviderStatusRow({ status, collapsed }) {
  const { loading, info, provider } = status;
  if (!provider) return null;
  if (loading && !info) return null;

  const configured = !!info?.configured;
  const apiStatus = info?.status || (configured ? 'valid' : 'unconfigured');
  const tone =
    apiStatus === 'valid'
      ? { dot: 'bg-success-400', text: 'text-success-300', label: 'OK' }
      : apiStatus === 'invalid'
      ? { dot: 'bg-danger-400', text: 'text-danger-300', label: 'Invalid' }
      : { dot: 'bg-warn-400', text: 'text-warn-300', label: 'Missing key' };

  const providerLabel = provider === 'copilot' ? 'Copilot (VS Code)' : (provider === 'gemini' ? 'Gemini' : 'Claude');
  const settingsTo = provider === 'copilot' ? '/settings' : `/settings/${provider}`;

  // Collapsed mode: a single status dot under the Settings cog. Tooltip
  // carries the human label so it's still discoverable.
  if (collapsed) {
    return (
      <li>
        <NavLink
          to={settingsTo}
          title={`${providerLabel} · ${tone.label}`}
          className="relative flex items-center justify-center px-0 py-1 mx-2 rounded-md text-ink-400 hover:text-white"
        >
          <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
          <span
            className={`absolute top-0.5 right-1 w-1.5 h-1.5 rounded-full ${tone.dot}`}
            aria-hidden="true"
          />
          <span className="sr-only">{providerLabel} status: {tone.label}</span>
        </NavLink>
      </li>
    );
  }

  return (
    <li>
      <NavLink
        to={settingsTo}
        className="flex items-center gap-2 px-3 py-1.5 mx-2 rounded-md text-2xs text-ink-400 hover:bg-white/5 hover:text-white"
        title={`${providerLabel} provider: ${tone.label}`}
      >
        <Cpu className="w-3 h-3 shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate">{providerLabel}</span>
        <span className={`inline-flex items-center gap-1 ${tone.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
          <span className="font-semibold uppercase tracking-wider">{tone.label}</span>
        </span>
      </NavLink>
    </li>
  );
}

export { COLLAPSE_KEY };
export default memo(Sidebar);
